# Seller guide — putting an x402 paywall on your API

This guide is for the **seller**: you already have an HTTP API and want some of
its routes to answer only after payment. The buyer side (a frontend paying from
a wallet) is [`dapp-guide.md`](./dapp-guide.md); running the facilitator is
[`operator-guide.md`](./operator-guide.md).

A seller does exactly three things:

1. **Define terms** — which chain, which token, how much, paid to whom.
2. **Wrap the route in `paywall`** — no payment → 402; payment → verify, settle, run the handler.
3. **Point at a facilitator** — the server that verifies and settles on-chain for you.

The seller holds no private key, needs no RPC, and pays no gas. All of that is
the facilitator's job.

---

## 0. Install and the big picture

```bash
npm i @x402kit/seller @x402kit/core
```

```
buyer ──(1) GET /premium──────────────────▶ seller
      ◀─(2) 402 + PAYMENT-REQUIRED ────────
      ──(3) GET /premium + PAYMENT-SIGNATURE ─▶ seller ──verify/settle──▶ facilitator ──tx──▶ chain
      ◀─(4) 200 + PAYMENT-RESPONSE (tx hash) ─
```

`paywall` does (2)–(4). Your handler runs only after payment.

---

## 1. Defining terms

Terms are the `PaymentRequirements` objects in the 402's `accepts[]`. Written by
hand:

```ts
const terms = {
  scheme: "exact",                 // fixed amount
  network: "eip155:8453",          // CAIP-2 (Base mainnet)
  asset: TOKEN_ADDRESS,            // ERC-20 address
  amount: "10000",                 // atomic units (USDC has 6 decimals → 0.01 USDC)
  payTo: MY_ADDRESS,               // recipient
  maxTimeoutSeconds: 60,           // signature validity
  extra: { name: "USD Coin", version: "2" },  // the token's EIP-712 domain — required
};
```

`extra.name` / `extra.version` must match the token contract's EIP-712 domain
**exactly**; a mismatch makes every buyer signature fail verification. Don't
hand-write it — use a helper:

### 1a. EIP-3009 tokens (USDC etc.) — `erc3009Terms`

Reads the domain off the token (ERC-5267). Needs an RPC read, so it is async —
call it once at boot and cache the result:

```ts
import { erc3009Terms } from "@x402kit/seller";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

const terms = await erc3009Terms({
  network: "eip155:8453",
  asset: USDC,
  payTo: MY_ADDRESS,
  amount: "10000",
  publicClient,
});
```

### 1b. Plain ERC-20s (no EIP-3009) — `permit2Terms`

Most ERC-20s. Settled through Permit2; no domain, no RPC, synchronous:

```ts
import { permit2Terms } from "@x402kit/seller";

const terms = permit2Terms({ network: "eip155:8453", asset: MY_TOKEN, payTo: MY_ADDRESS, amount: "10000" });
// terms.extra.assetTransferMethod === "permit2"
```

The buyer needs a **one-time** Permit2 `approve` on that token
(`approvePermit2` in `@x402kit/buyer`). Nothing for the seller to do, but tell
your buyers in your docs/UI.

### Two pricing models: a fixed price (`exact`) or a cap (`upto`)

`exact` charges **one fixed amount per request** — "$0.01 per call", "$2 per
report". `upto` is for a charge you only know **after** doing the work — an AI
call billed by output tokens, fuel, a deposit: the buyer signs a **cap**, your
handler measures, and you settle the actual (≤ cap, `"0"` allowed). One cap is
drawn once. For per-period billing use the pre-signed schedules in §7.

```ts
import { uptoTerms, SETTLEMENT_OVERRIDES_HEADER } from "@x402kit/seller";

// 1. terms: the cap, and the facilitator's address from its /supported (kinds[].extra.facilitatorAddress)
const terms = uptoTerms({ network, asset: USDC, payTo: MY_ADDRESS, maxAmount: "1000000", facilitatorAddress });

// 2. after-handler mode: the handler names the real charge, the adapter settles it
app.use("/v1/answer", paywall({ accepts: [terms], facilitator: FACILITATOR_URL, settle: "after-handler", onSettled }));
app.post("/v1/answer", async (c) => {
  const { text, usage } = await model.complete(await c.req.json());
  c.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: priceFor(usage) })); // atomic units, ≤ cap
  return c.json({ text });
});
```

With the core directly, call `decision.capture({ amount })` yourself. Notes:
upto is Permit2-only (same one-time `approvePermit2` on the buyer as
exact/permit2); the facilitator must advertise `upto` and you must bind its
address, or buyers cannot sign; the `Settlement-Overrides` header is stripped
before the response leaves; an amount above the cap never reaches the
facilitator — it fails locally via `onSettled`. Hook-style express/fastify run
before your handler, so they cannot use this — use hono, next, or the core. On
plain node:http drive the core yourself and `capture({ amount })` **before**
`res.end()` (see `examples/metered-api.ts`): the node `withPaywall` wrapper
captures after your handler has ended the response, so the receipt — which the
buyer needs to true its budget up to the actual — would not reach them.

### Offering several options

`accepts` is an array. Two chains or two tokens → two entries. The buyer's
`wrapFetch` picks the intersection with its own allowlist.

---

## 2. Wrapping the route

### Hono

```ts
import { Hono } from "hono";
import { paywall } from "@x402kit/seller/hono";

const app = new Hono();
app.use("/premium/*", paywall({ accepts: [terms], facilitator: FACILITATOR_URL }));
app.get("/premium/report", (c) => c.json({ data: "..." }));
```

### Express

```ts
import express from "express";
import { paywall } from "@x402kit/seller/express";

const app = express();
app.use("/premium", paywall({ accepts: [terms], facilitator: FACILITATOR_URL }));
app.get("/premium/report", (req, res) => res.json({ data: "..." }));
```

### Fastify

```ts
import { paywall } from "@x402kit/seller/fastify";

fastify.addHook("preHandler", paywall(options));        // global
// or per route
fastify.get("/premium/report", { preHandler: paywall(options) }, handler);
```

### Next.js (App Router)

```ts
// app/api/premium/route.ts
import { withPaywall } from "@x402kit/seller/next";

export const GET = withPaywall(options, async (req) => Response.json({ data: "..." }));
```

### No framework (`node:http`)

```ts
import { withPaywall } from "@x402kit/seller/node";
import { createServer } from "node:http";

createServer(withPaywall(options, (req, res) => { res.end("paid content"); })).listen(3000);
```

### Anything else — use the core directly

Every adapter is 10–15 lines on top of `createPaywall(options).check(request)`.
On a web-standard `Request`/`Response` runtime (Deno, Bun, Cloudflare Workers,
SvelteKit, …) call it yourself:

```ts
import { createPaywall } from "@x402kit/seller";

const gate = createPaywall(options);

export default async function handler(request: Request): Promise<Response> {
  const decision = await gate.check(request);
  if (!decision.paid) return decision.response;             // 402 or 503 — return as-is

  const body = await doTheWork();
  return new Response(body, { headers: decision.responseHeaders }); // carries PAYMENT-RESPONSE in the default "sync" mode
}
```

If you use the core directly with `settle: "after-handler"`, the decision
carries a `capture()` **you must call** after your handler succeeds — the
wrapper adapters do this for you; a hand-rolled integration that forgets it
never settles. In `async` / `none` / `after-handler` modes `responseHeaders`
is empty; the tx hash arrives via `onSettled` (or `capture()`'s return value).

hono/express/fastify are **not dependencies** — the adapters are typed
structurally, so any installed version works.

---

## 3. Connecting the facilitator

The `facilitator` option accepts two things.

**A URL string** — the common case. For an API key or timeout, build the
`FacilitatorClient` yourself:

```ts
import { FacilitatorClient } from "@x402kit/seller";

const facilitator = new FacilitatorClient("https://facilitator.example.com", {
  apiKey: process.env.FACILITATOR_API_KEY,  // the operator's SETTLE_API_KEY
  timeoutMs: 30_000,                        // default 30 s
  // allowInsecure: true,                   // plain http:// to a non-loopback host warns by default
});
```

**Any object with `verify`/`settle`** — to embed the facilitator in the seller
process:

```ts
import { createFacilitator, loadConfig } from "@x402kit/facilitator";

const facilitator = createFacilitator(loadConfig("facilitator.config.json"));
createPaywall({ accepts, facilitator });   // no HTTP round trip
```

Embedding means the seller process holds the gas key; with a separate ops team,
deploy it separately. Configuration is identical either way — see
[`operator-guide.md`](./operator-guide.md).

### Validate the setup at boot

```ts
const gate = createPaywall(options);
await gate.verifySupported();   // asserts every (scheme, network) in accepts is advertised by the facilitator — throws on mismatch
```

Catches "the facilitator doesn't know this chain" before the first customer.
No-op for an embedded facilitator.

---

## 4. Settlement mode (`settle`)

When the money actually moves. The default is the safest; the rest are explicit
choices.

| Mode | Behaviour | Use when |
|---|---|---|
| `"sync"` (default) | verify → **settle** → handler → response carries tx hash | Ordinary paid APIs. Simplest; goods leave after funds land. |
| `"after-handler"` | verify → handler → settle only if the handler didn't throw | The handler can fail and you don't want to charge for a 500. |
| `"async"` | verify → respond immediately → settle in background → `onSettled` | Latency-critical, POS-style authorize/capture split. |
| `"none"` | verify only → hand the payload over via `onVerified` (required) | You control settlement timing yourself (e.g. subscription enrolment). |

```ts
paywall({
  accepts, facilitator,
  settle: "after-handler",
  onSettled: (result, payload) => {
    // In after-handler / async mode this hook is your ONLY accounting channel.
    if (!result.success) alertOps("settlement failed", payload, result.errorReason);
    else db.recordPayment(payload, result.transaction);
  },
});
```

Caveats:
- The "don't charge on handler failure" guarantee of `"after-handler"` holds
  only for **wrapper adapters** (node, next, hono). Hook-style express/fastify
  run before the handler, so they behave like `"sync"`. On node `withPaywall`
  the tx hash is not attached to the response in this mode (headers are already
  sent) — read it from `onSettled`.
- In every mode but `"sync"` the goods leave before the chain consumes the
  nonce. What makes "one signature = one delivery" hold there is the replay
  guard below.

---

## 5. Replay guard and multiple instances

Verification is an on-chain *read*, so until settlement is mined the same
signature looks valid N times. `paywall` therefore claims the signature's
`paymentId` **before** calling the facilitator and answers a second
presentation with 402 `authorization_already_used`. The default store is
in-process memory.

**With more than one seller instance**, pass a shared store:

```ts
import type { ReplayStore } from "@x402kit/seller";

const redisReplayStore: ReplayStore = {
  // atomic claim — only the first caller gets true (SET NX PX)
  async claim(id, ttlMs) {
    return (await redis.set(`x402:replay:${id}`, "1", "PX", ttlMs, "NX")) === "OK";
  },
  // called by the paywall when verification rejects the payment or settlement definitively
  // fails, so the buyer can retry with the same signature. NOT called on `settlement_pending`
  // — the claim is kept until TTL (max(maxTimeoutSeconds, 300) s) while the tx may still land.
  async release(id) {
    await redis.del(`x402:replay:${id}`);
  },
};

paywall({ accepts, facilitator, replayStore: redisReplayStore });
```

`replayStore: false` disables it — only sane with `settle: "sync"` when you
accept the short pre-mining window.

Also on by default:
- **Resource binding** (`bindResource`, default true): if the payload carries
  `resource.url` it must match this route — a signature for `/cheap-a` can't be
  presented at `/cheap-b` (refused with 402 `invalid_payment_requirements`, no
  facilitator call).
- **Header cap**: a `PAYMENT-SIGNATURE` longer than 8 KB
  (`MAX_PAYMENT_HEADER_BYTES`) is refused with 402 `invalid_payload` before any
  decoding.
- **Reason filtering**: only known protocol codes are echoed into a 402; anything
  else becomes a generic message.

---

## 6. Failure behaviour

| Situation | Response | Note |
|---|---|---|
| No payment header | 402 + `PAYMENT-REQUIRED` | first step of the normal flow |
| Malformed header | 402 `invalid_payload` | no facilitator call |
| Signed against unknown terms | 402 `invalid_payment_requirements` | no facilitator call |
| Same signature again | 402 `authorization_already_used` | no facilitator call |
| Verify rejected (balance, expiry, …) | 402 + reason + fresh terms | buyer can re-sign |
| Facilitator down / timeout / bad reply | **503** `facilitator_unavailable` + `retry-after: 5` | every transport failure of the HTTP facilitator client becomes this 503 instead of throwing — no 500, no stack trace. (An `onVerified` that throws releases the claim and becomes this 503 too; exceptions from your own `replayStore` or an embedded facilitator still propagate.) |

Show 503 as "payments under maintenance". The buyer's `wrapFetch` passes it
through rather than treating it as a refusal.

---

## 7. Subscriptions and installments (pre-signed schedules)

The buyer pre-signs one payment per billing period (`signPaymentSchedule` in
`@x402kit/buyer`); you accept, store, and settle when due. No 402 round trip,
so the buyer may be offline at billing time.

```ts
import { validateSchedule, dueEntries, chargeScheduled, scheduleEntryId } from "@x402kit/seller";

// 1) subscribe endpoint (Express, with express.json()) — the body is an untrusted JSON array
app.post("/subscribe", async (req, res) => {
  const result = validateSchedule(req.body, [monthlyTerms]);
  // checks: ≤1000 entries · exact scheme · terms match · unique paymentId · ordered & disjoint windows
  //         · first window not closed >1 day ago · within horizon (default 400 days)
  if (!result.ok) return res.status(400).json({ error: result.error });
  await db.saveSchedule(userId, result.value);
  res.json({ ok: true });
});

// 2) billing cron — e.g. hourly
async function billingTick() {
  const now = Math.floor(Date.now() / 1000);
  // isSettled must be SYNCHRONOUS ((id, entry) => boolean) — load the settled ids first
  const settled = new Set(await db.settledScheduleEntryIds());
  const isSettled = (id: string) => settled.has(id);
  for (const entry of dueEntries(await db.loadAllSchedules(), now, { isSettled })) {
    const result = await chargeScheduled(entry, facilitator);
    if (result.success) await db.recordCharge(scheduleEntryId(entry), result.transaction);
    else log.warn("charge failed", scheduleEntryId(entry), result.errorReason); // retried next tick
  }
}
```

Division of labour:
- **Kit**: validation, window math, submission. Too-early submission is refused by the scheme's own time check.
- **You**: storage, retry policy, cancellation.

Non-negotiable:
- Every stored entry is a **live bearer authorization**. Encrypt at rest, restrict access.
- Persist `scheduleEntryId` with each successful charge so the cron never resubmits a settled installment (`isSettled` reads it).
- Full runnable example: `examples/subscription.ts`, `playground/c-schedule.ts`.

---

## 8. Checklist

- [ ] Terms built with `erc3009Terms` / `permit2Terms`, not a hand-written `extra` domain.
- [ ] Facilitator URL is `https://` and the operator's API key goes through `FacilitatorClient({ apiKey })`.
- [ ] `verifySupported()` called at boot.
- [ ] Shared `replayStore` (Redis `SET NX PX`) if running more than one instance.
- [ ] If `settle` isn't `"sync"`, `onSettled` records and alerts on failures.
- [ ] 503 `facilitator_unavailable` handled as a maintenance state by your UI/clients.
- [ ] If accepting schedules: store encrypted, dedupe with `scheduleEntryId`.
- [ ] Asked the facilitator operator to add your `payTo` to `allowedPayTo` (if they use that control).

## Where to go next

- `packages/seller/README.md` — every option, reference-style.
- [`operator-guide.md`](./operator-guide.md) — running the facilitator yourself.
- [`dapp-guide.md`](./dapp-guide.md) — the buyer side, for the frontend that will call your API.
- `examples/seller-paid-api.ts` — the flow in this guide, runnable.
