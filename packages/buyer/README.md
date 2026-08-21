# @x402kit/buyer

Buyer-side x402 client. Wrap fetch once; 402s get paid and retried, with a
hard spending cap the wrapper will never sign past.

```ts
import { wrapFetch } from "@x402kit/buyer";

const paidFetch = wrapFetch(fetch, {
  signer,                 // viem LocalAccount, or any PaymentSigner (passkey wallets welcome)
  maxAmount: "1000000",   // atomic units — terms above this are never signed
  assets: [USDC],         // token allowlist — required (see below)
});

const res = await paidFetch("https://api.example.com/premium");
```

- `maxAmount` is required by design — an agent without a spending cap is an
  incident waiting to happen. Refusals do not throw; the original 402 comes
  back and `onSkipped` tells you why.
- `assets` (a token-address allowlist) is **also required** — `maxAmount` is a
  bare atomic-unit number with no notion of which token or how many decimals,
  so without it a hostile 402 could name an expensive token (WBTC) at the same
  integer. Pass `allowAnyAsset: true` to consciously opt out. Filter further
  with `networks` / `schemes`; observe with `onPaid`.
- `maxAmount` bounds ONE payment. `maxTotalAmount` bounds the SUM of every
  payment a wrapper signs — set it for unattended agents, or a seller that
  answers 402 to every request is limited only by your balance.
- `upto` terms (a cap the seller settles at or below) are paid by default:
  `maxAmount` and `maxTotalAmount` both count the **cap** — the worst case you
  signed. The seller-reported actual charge in `PAYMENT-RESPONSE` is exposed
  through `onPaid(terms, settlement)` for your own accounting but never
  restores the budget (a seller could claim anything). Restrict with
  `schemes: [exactScheme]` to refuse caps.
- For QR/POS flows without fetch, `signPayment(requirements, { signer })`
  signs chosen terms directly.
- Paying with a token that lacks EIP-3009 (the permit2 path)? Run the one-time
  `approvePermit2({ walletClient, publicClient, token })` first — the only
  gas-spending call in this package; it no-ops when already approved and
  refuses to approve an address with no contract code. The allowance is
  unlimited by convention and outlives this kit — `revokePermit2` sets it
  back to zero. After that, payments are signature-only as usual.
- Subscriptions/installments: `signPaymentSchedule(terms, { signer, periods,
  maxTotalAmount, assets })` signs one standard payment per billing period in
  a single ceremony. Exposure is exactly n × amount — signing refuses past
  `maxTotalAmount` — and each installment only settles inside its own window.
  `assets` is required here for the same reason as on `wrapFetch` (the terms
  usually come from the seller). Undo: `revokePermit2` for permit2 schedules;
  EIP-3009 installments expire with their windows (or `cancelAuthorization`
  on the token).
- Axios? `import { attachX402 } from "@x402kit/buyer/axios"; attachX402(axios, { signer, maxAmount, assets })`
  — same safety model, handling axios's 402-as-rejection and retrying once.
- Retry safely by re-sending the SAME signed payload (same nonce) — the
  facilitator dedupes on the signed on-chain nonce, so a resend settles once.
  A fresh signature is a genuinely new payment (there is no unsigned
  "idempotency key" that could be abused to replay one payment as many).
- Schemes whose terms outlive one request declare `requiresConsent`; the
  wrapper refuses to sign them unless their name appears in `consentTo`.
- A signed authorization is a bearer instrument, so the wrapper defends it:
  the on-chain validity window is clamped to `maxValiditySeconds` (default 300s)
  regardless of what the server proposes; a 402 that arrived via a redirect to
  another origin is never signed; and the paid retry is sent
  `redirect: "manual"` to the original origin only — the `PAYMENT-SIGNATURE`
  header is never followed to a redirect target. (The axios adapter pins
  `maxRedirects: 0` / `fetchOptions.redirect: "manual"`; the browser XHR
  adapter cannot suppress redirects, so in browsers use `adapter: "fetch"`.)
