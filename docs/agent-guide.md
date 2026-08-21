# Agent guide — paying for APIs from a bot, agent, or server

This guide is for the **unattended buyer**: an AI agent calling paid tools, a
cron job hitting a metered data feed, a backend service consuming a paid API.
The defining property is that **nobody is there to approve each payment** —
the process holds a key and signs on its own. If a human approves every
payment in a browser wallet, read [`dapp-guide.md`](./dapp-guide.md) instead;
the wire protocol is identical, only the signer and the safety model differ.

The integration is three steps:

1. Turn the key into a signer (one line — no adapter needed).
2. Wrap `fetch` with `wrapFetch` under **two** caps: per payment and cumulative.
3. (permit2 tokens only) `approve` Permit2 once per token.

Everything after that is about running it safely without supervision.

---

## 1. The signer — a viem `LocalAccount` is already one

`PaymentSigner` is `{ address, signTypedData }`. viem's `privateKeyToAccount`
returns exactly that, so:

```ts
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`);
```

That key **never sends a transaction** for a payment — it signs an EIP-712
authorization and the facilitator submits the transfer on its own gas. Its only
on-chain action is the one-time Permit2 approve in §3. Treat it like any
production secret: inject from a secret manager, never commit, and keep only
the balance the agent is allowed to spend in that wallet (see §4).

A KMS/HSM-backed signer works too — implement `signTypedData` over your signing
service and return `{ address, signTypedData }`.

---

## 2. `wrapFetch` with two caps

```ts
import { wrapFetch } from "@x402kit/buyer";

const payFetch = wrapFetch(fetch, {
  signer,
  maxAmount: "100000",          // per-payment cap, atomic units (0.10 USDC) — REQUIRED
  maxTotalAmount: "20000000",   // cumulative cap for this wrapper's lifetime (20 USDC) — set it for anything unattended
  assets: [USDC],               // token allowlist — REQUIRED (maxAmount is token-blind)
  networks: ["eip155:8453"],    // optional: only these CAIP-2 networks
  onPaid: (terms, settlement) => metrics.paid(terms.amount, settlement?.transaction),
  onSkipped: (reason, accepts) => log.warn("402 not paid:", reason),
});

const res = await payFetch("https://api.example.com/v1/answer", { method: "POST", body });
```

What each cap protects against:

| Option | Bounds | Without it |
|---|---|---|
| `maxAmount` | one payment | a hostile or misconfigured 402 names a huge price and the agent signs it |
| `maxTotalAmount` | the sum of every payment this wrapper signs | a seller that answers 402 to **every** request — or the agent's own retry loop — drains the wallet one legal payment at a time |
| `assets` | which tokens | `maxAmount` is a bare integer with no decimals; the same number in WBTC is worth thousands of times more than in USDC |
| `maxValiditySeconds` (default 300) | how long a signature stays valid | a seller proposing `maxTimeoutSeconds: 10 years` turns your signature into a long-lived bearer instrument |

The budget behind `maxTotalAmount` is **reserved before signing and refunded
only if the paid request never reaches the seller** — i.e. the retry throws a
transport error. A retry that reaches the seller but comes back non-2xx
**still counts against the budget**: the seller held a valid signature and may
have settled it. The budget lives in the wrapper instance — construct one
wrapper per budget scope (per agent run, per tenant, per task).

### Refusals never throw

When a 402 can't be paid under your policy, `payFetch` returns the **original
402 response** and calls `onSkipped(reason)`. Your loop decides — escalate to
a human, try a cheaper tool, stop. Check `res.status === 402` after the call if
the agent must know whether it actually got the resource. (Two exceptions: when
the paid retry is redirected or crosses origins, the wrapper refuses to forward
the signature and returns that 3xx/cross-origin response instead — `onSkipped`
still fires, so watch it rather than relying on the status alone.)

### Other things the wrapper enforces

- Pays and retries **exactly once per call**. No exponential retry loops with fresh signatures inside the wrapper — your own loop calling `payFetch` again is what `maxTotalAmount` bounds.
- The paid retry is sent with `redirect: "manual"` to the **same origin only** — the signature is never forwarded to a redirect target. A 402 that itself arrived via a redirect to another origin is never signed either.
- A streaming request body can't be replayed; buffer bodies you may need to pay for.
- Non-402 responses (including the seller's 503 `facilitator_unavailable`) pass through untouched.

### Caps, not prices (`upto`)

Some sellers price by usage — an AI call billed by output tokens — and ask you
to sign a **cap** (scheme `upto`) rather than a price. The wrapper pays those by
default: `maxAmount` bounds the cap (the worst case you authorize) and
`maxTotalAmount` is charged the full cap too — the seller-reported actual in
`PAYMENT-RESPONSE` (`onPaid`'s `settlement.amount`) is for your books, not for
the budget, since a seller can claim any figure. One cap is drawn once. To
refuse caps altogether, pass `schemes: [exactScheme]`.

### Axios instead of fetch

```ts
import { attachX402 } from "@x402kit/buyer/axios";
attachX402(axiosInstance, { signer, maxAmount, maxTotalAmount, assets });
```

Same options, same gates.

---

## 3. Permit2 tokens: the one transaction

Tokens without EIP-3009 (most ERC-20s) settle through Permit2 and need a
one-time on-chain `approve` from the buyer. This is the **only** gas the agent's
wallet ever spends:

```ts
import { approvePermit2 } from "@x402kit/buyer";
import { createPublicClient, createWalletClient, http } from "viem";

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = createWalletClient({ account: signer, transport: http(RPC_URL) });

// at deploy / first run, per token
await approvePermit2({ walletClient, publicClient, token: TOKEN });
// returns the tx hash when it approves, undefined when the allowance is already sufficient — safe to call on every boot.
// Throws if the Permit2 address holds no contract code on that chain (wrong chain / private deployment).
```

The allowance is unlimited by convention and outlives the agent.
`revokePermit2({ walletClient, publicClient, token })` sets it back to zero —
call it when decommissioning. USDC and other EIP-3009 tokens skip this step.

---

## 4. Running unattended — the operational model

The caps above are code-level limits. Layer these on top:

**Wallet = budget.** Fund the agent's wallet with only what it may spend in a
period. A compromised key or a bug can then lose at most that balance, and
`maxTotalAmount` should be at or below it. Top up from a treasury you control,
not the other way round.

**One wrapper per budget scope.** `maxTotalAmount` is per wrapper instance. A
long-lived process serving many tasks should build a wrapper per task/tenant so
one runaway task can't consume another's budget.

**Observe both hooks — and the status.** `onPaid` is your spend ledger;
`onSkipped` is where mispriced endpoints, exhausted budgets, and hostile 402s
show up. Emit both to metrics — a spike in `onSkipped` with "exceed
maxTotalAmount" means the agent hit its ceiling and is now silently failing
every paid call. One gap to know: `onPaid` fires **only when the paid retry
returns 2xx**. A paid retry that comes back non-2xx fires neither hook yet still
consumed budget (the seller had a valid signature), so if the ledger must be
exact, also record the returned `res.status` after every call.

**Decide the 402 policy in the loop, not in the wrapper.** The wrapper's job is
to never sign past the caps. What to do when it refuses — retry later, pick a
different provider, ask a human — is agent logic, and `onSkipped` plus the
returned 402 give it what it needs.

**Clock.** Signatures carry validity windows. If the host's clock drifts from
chain time the facilitator rejects them; keep NTP on, or pass `clock` to use a
trusted time source.

---

## 5. Inside an LLM tool call (sketch)

```ts
// build once per agent run, with that run's budget
const payFetch = wrapFetch(fetch, {
  signer, maxAmount: "100000", maxTotalAmount: runBudget, assets: [USDC],
  onPaid: (t) => ledger.push({ tool: "search", amount: t.amount }),
  onSkipped: (reason) => ledger.push({ tool: "search", skipped: reason }),
});

const tools = {
  search: async (query: string) => {
    const res = await payFetch(`https://search.example.com/q?q=${encodeURIComponent(query)}`);
    if (res.status === 402) return { error: "search is paid and the budget/policy refused it" };
    if (res.status === 503) return { error: "search payments temporarily unavailable" };
    return res.json();
  },
};
```

The model never sees the key or the caps. It sees a tool that sometimes says
"refused" — and the caller sees exactly why in the ledger.

---

## 6. Subscriptions from an agent

If a provider bills per period rather than per call, the agent can pre-sign a
schedule in one ceremony:

```ts
import { signPaymentSchedule } from "@x402kit/buyer";

const payloads = await signPaymentSchedule(monthlyTerms, {
  signer,
  periods: { start: Math.floor(Date.now() / 1000), periodSeconds: 30 * 86_400, count: 12 },
  maxTotalAmount: "120000000",  // 12 × 10 USDC — signing refuses past this
  assets: [USDC],
});
await fetch("https://provider.example.com/subscribe", { method: "POST", body: JSON.stringify(payloads) });
```

Exposure is exactly `count × amount`; each installment only settles inside its
own window. See `examples/subscription.ts`.

---

## Checklist

- [ ] Key injected from a secret manager; wallet holds only the period's budget.
- [ ] `maxAmount` **and** `maxTotalAmount` **and** `assets` set; `maxTotalAmount` ≤ wallet balance.
- [ ] One wrapper per budget scope (run / tenant / task).
- [ ] `onPaid` and `onSkipped` wired to metrics/logs; alert on skip spikes.
- [ ] Agent loop handles a returned 402 (policy refusal) and 503 (facilitator down) explicitly.
- [ ] For permit2 tokens: `approvePermit2` at boot, `revokePermit2` at decommission.
- [ ] Host clock synced (or `clock` provided).

## Where to go next

- `packages/buyer/README.md` — every `wrapFetch` option.
- `examples/seller-paid-api.ts` — an agent paying a paid API end to end, runnable on anvil.
- [`seller-guide.md`](./seller-guide.md) — what the API you're calling is doing on its side.
- [`dapp-guide.md`](./dapp-guide.md) — the human-approved variant.
