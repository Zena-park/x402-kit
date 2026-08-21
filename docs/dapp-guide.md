# Using x402-kit in a dapp (browser wallet)

This guide takes a frontend dapp from "user has a connected wallet" to "user
has paid an x402 endpoint" — the one path the package READMEs assume you
already know. If you are building an agent or a server (a private key you
control), the buyer README's `wrapFetch` is simpler; come back here only when a
human approves each payment in their browser wallet.

The whole integration is three steps:

1. Adapt the browser wallet to a `PaymentSigner` (≈5 lines).
2. Pay — let `wrapFetch` handle 402 → sign → retry, or drive `signPayment`
   yourself for a custom flow.
3. (permit2 tokens only) Get the buyer to `approve` Permit2 once.

---

## 1. The wallet adapter — the only glue you write

Everything buyer-side takes a `PaymentSigner`, which is deliberately tiny:

```ts
interface PaymentSigner {
  address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}
```

A viem **wallet client** (what wagmi's `getWalletClient` / `useWalletClient`
hands you, backed by MetaMask, Rabby, Coinbase Wallet, a WalletConnect session,
anything) already signs typed data — its method just takes the account
alongside the payload. So the adapter is a shape change, not real code:

```ts
import type { Account, WalletClient } from "viem";
import type { PaymentSigner } from "@x402kit/core";

export function walletSigner(wallet: WalletClient, account: Account | `0x${string}`): PaymentSigner {
  const address = typeof account === "string" ? account : account.address;
  return {
    address,
    signTypedData: (typedData) => wallet.signTypedData({ account, ...typedData }),
  };
}
```

That's the whole thing. The buyer signs an EIP-712 message (a *permission*, not
a transaction) — no gas, no popup that says "confirm transaction", just a
signature request. The facilitator submits the on-chain transaction and pays
the gas.

> **Passkey / smart-account wallets** implement the same `PaymentSigner`
> interface directly (they sign with P-256, which `wrapFetch` never needs to
> know about). Verification handles EOA, ERC-1271, and ERC-6492 signatures
> through one code path, so a smart-account buyer "just works" on the seller
> side.

---

## 2a. Pay with `wrapFetch` (the common case)

If your dapp calls the paid endpoint with `fetch`, wrap it once and payment
becomes invisible — a 402 is caught, signed, and retried:

```ts
import { wrapFetch } from "@x402kit/buyer";

const payFetch = wrapFetch(fetch, {
  signer: walletSigner(wallet, account),
  maxAmount: "5000000",          // hard cap in atomic units — never signs above this
  assets: [USDC],                // required token allowlist (maxAmount is token-blind)
  onSkipped: (reason) => toast(`payment skipped: ${reason}`),
  onPaid: (terms, settlement) => toast(`paid, tx ${settlement?.transaction}`),
});

const res = await payFetch("/api/premium"); // 402 → wallet signature prompt → retry → 200
```

`maxAmount` is required by design — it is the ceiling the wrapper will never
sign past, so a compromised or misbehaving endpoint cannot drain the wallet.
`assets` is required too: `maxAmount` is a bare atomic-unit number, so without a
token allowlist a hostile 402 could name an expensive token at the same integer
(set `allowAnyAsset: true` only if you truly accept any token). A refusal does
**not** throw: the original 402 comes back and `onSkipped` tells you why, so
your UI stays in control. (Sellers may also offer `upto` terms — a cap the seller
settles at or below; the wallet prompt then shows the cap, and `onPaid`'s
`settlement.amount` is what was actually charged.)

The one dapp wrinkle: the signature prompt is async and user-driven. `payFetch`
already awaits it — just make sure the call sits behind a user action (a "Pay"
button), not an automatic page-load fetch, so the wallet popup has a gesture to
attach to.

## 2b. Pay with `signPayment` (custom UI)

When you want to show the user the terms, your own confirm dialog, then sign —
drive the low-level call and attach the header yourself:

```ts
import { signPayment } from "@x402kit/buyer";
import {
  HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequiredSafe, encodePaymentPayload,
} from "@x402kit/core";

// 1. hit the endpoint, read the 402 terms (the Safe decoder never throws on a malformed header)
const first = await fetch("/api/premium");
const required = decodePaymentRequiredSafe(first.headers.get(HEADER_PAYMENT_REQUIRED) ?? "");
if (!required.ok) throw new Error(`bad 402: ${required.error}`);
const terms = required.value.accepts[0]!;        // pick the entry your dapp supports (non-empty on a valid 402)

// 2. show `terms` in your own UI, then on confirm:
const payload = await signPayment(terms, { signer: walletSigner(wallet, account) });

// 3. replay the request with the signature header
const paid = await fetch("/api/premium", {
  headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) },
});
```

`signPayment` is transport-agnostic — this same call is what a POS terminal
uses to sign QR-delivered terms (see `playground/b-pos.ts`).

---

## 3. Permit2 tokens: one-time approve

Most ERC-20s don't implement EIP-3009, so the kit routes them through Permit2
(the seller's terms carry `extra.assetTransferMethod: "permit2"`). Permit2
needs a one-time on-chain `approve` from the buyer per token — the single
gas-spending action in the buyer flow. Do it before the first payment:

```ts
import { approvePermit2 } from "@x402kit/buyer";

// walletClient is a viem WalletClient with an account; publicClient reads chain state
const tx = await approvePermit2({ walletClient, publicClient, token: TOKEN_ADDRESS });
// tx === undefined means the allowance was already sufficient — nothing was sent
```

A good dapp checks this up front and shows an "Enable {token}" step once, then
never again. Tokens that DO implement EIP-3009 (e.g. USDC) skip this entirely —
they need no approve.

---

## Putting it together (wagmi sketch)

```ts
import { useWalletClient, usePublicClient, useAccount } from "wagmi";
import { wrapFetch, approvePermit2 } from "@x402kit/buyer";

function usePayFetch(maxAmount: string, assets: `0x${string}`[]) {
  const { address } = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();

  async function enable(token: `0x${string}`) {
    if (!wallet || !publicClient) throw new Error("connect a wallet first"); // usePublicClient() may be undefined
    return approvePermit2({ walletClient: wallet, publicClient, token });
  }

  const payFetch = wallet && address
    ? wrapFetch(fetch, { signer: walletSigner(wallet, address), maxAmount, assets })
    : undefined;

  return { payFetch, enable };
}
```

`payFetch` is undefined until a wallet is connected — gate your "Pay" button on
it. `enable(token)` is your one-time Permit2 approve for permit2-settled tokens.

---

## Checklist

- [ ] Wrote the ~5-line `walletSigner` adapter (viem wallet client → `PaymentSigner`).
- [ ] Set a real `maxAmount` ceiling AND an `assets` allowlist on `wrapFetch` (and `maxTotalAmount` for anything unattended).
- [ ] Put the pay call behind a user gesture so the wallet prompt attaches.
- [ ] For permit2-settled tokens, added a one-time `approvePermit2` "enable" step (and a `revokePermit2` "disable" somewhere in settings — the allowance is unlimited and outlives the app).
- [ ] Surfaced `onSkipped` / caught refusals in the UI (they don't throw).

## Where to go next

- `packages/buyer/README.md` — every `wrapFetch` option (asset/network
  filters, consent, validity clamping, the axios adapter).
- `playground/` — runnable seller + buyer + facilitator; `a-online.ts` is the
  paid-API flow this guide's step 2 mirrors.
- `packages/seller/README.md` — the other side, if your dapp also *sells*.
