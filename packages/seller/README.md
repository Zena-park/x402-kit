# @x402.kit/seller

Seller-side x402 middleware. One line gates a route behind payment; the
framework adapters are structural (hono/express are not dependencies).

```ts
import { paywall } from "@x402.kit/seller/hono"; // or /express, /fastify

app.use("/premium/*", paywall({
  accepts: [{
    scheme: "exact", network: "eip155:8453", amount: "10000",
    asset: TOKEN, payTo: ME, maxTimeoutSeconds: 60,
    extra: { name: "My Token", version: "1" },   // EIP-712 domain — required
  }],
  facilitator: "https://facilitator.example.com",
}));
```

No payment → 402 with `PAYMENT-REQUIRED`. Valid payment → verified and
settled through the facilitator, handler runs, and the response carries
`PAYMENT-RESPONSE` with the transaction hash.

Don't want to hand-write the token's EIP-712 domain? `erc3009Terms` reads it
off the token (ERC-5267):

```ts
import { erc3009Terms } from "@x402.kit/seller";
const terms = await erc3009Terms({ network, asset, payTo, amount: "10000", publicClient });
```

Token without EIP-3009 (most ERC-20s)? `permit2Terms` builds `exact` terms
settled through Permit2 — no domain, no client, synchronous. The buyer needs a
one-time `approve(Permit2, …)` on the token (`approvePermit2` in `@x402.kit/buyer`):

```ts
import { permit2Terms } from "@x402.kit/seller";
const terms = permit2Terms({ network, asset, payTo, amount: "10000" });
```

## Open-amount payments (`upto`) — sign a cap, settle the actual

For charges you only know after the work (an AI call billed by output tokens,
fuel, a deposit): the buyer signs a **cap**, your handler measures, you settle
the actual — ≤ cap, `"0"` allowed, one cap drawn once. Permit2 only. Bind the
facilitator's address (from its `/supported`, `kinds[].extra.facilitatorAddress`)
into the terms; the buyer bakes it into the signature so only that facilitator
can draw.

```ts
import { uptoTerms, SETTLEMENT_OVERRIDES_HEADER } from "@x402.kit/seller";

const terms = uptoTerms({ network, asset, payTo, maxAmount: "1000000", facilitatorAddress });
app.use("/v1/answer", paywall({ accepts: [terms], facilitator, settle: "after-handler", onSettled }));
app.post("/v1/answer", async (c) => {
  const { text, usage } = await model.complete(await c.req.json());
  c.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: priceFor(usage) })); // atomic units, ≤ cap
  return c.json({ text });
});
```

The hono and next adapters read and strip the `Settlement-Overrides` header
and call `capture({ amount })` for you, attaching the receipt. On node:http
drive the core yourself and capture **before** `res.end()`
(`examples/metered-api.ts`) — the node wrapper captures after the response has
ended, so the buyer would not get its receipt. An amount above the cap
fails locally (`onSettled`, no facilitator call); the first `capture()` wins.
The header is read from whatever `Response` your handler returns — if that is
a proxied upstream response, strip `Settlement-Overrides` from it first, or an
upstream you do not control decides what you charge.
Hook-style express/fastify run before the handler and cannot name an amount.

## Paid MCP tools

The same paywall over the Model Context Protocol — wrap one `registerTool`
tuple and the tool charges per call (spec `transports-v2/mcp.md`, wire-
compatible with the official `@x402/mcp` SDK):

```ts
import { paidTool } from "@x402.kit/seller/mcp";

server.registerTool(...paidTool("market_report",
  { accepts: [terms], facilitator },              // PaywallOptions, resource defaults to mcp://tool/<name>
  { description: "A paid market report", inputSchema: { ticker: z.string() } },
  async ({ ticker }) => ({ content: [{ type: "text", text: report(ticker) }] }),
));
```

A call without payment gets an `isError` result carrying the terms; a paid
call runs the handler and attaches the receipt in
`_meta["x402/payment-response"]`. `settle: "sync"` (default) or
`"after-handler"` — where a definite settlement failure after execution
withholds the tool's content (the atomicity HTTP cannot offer). For `upto`,
the handler names the actual via
`_meta: { "x402kit/settlement-overrides": { amount } }` on its result — the
MCP twin of the `Settlement-Overrides` header. `@modelcontextprotocol/sdk` is
not a dependency (structural typing, like the HTTP adapters). Runnable:
`examples/paid-mcp-tool.ts`.

## POS terminal (authorize / capture)

The in-person recipe as a preset — 402-as-QR, instant authorization at the
counter, on-chain capture off the customer's critical path:

```ts
import { createPosTerminal } from "@x402.kit/seller/pos";

const pos = createPosTerminal({ facilitator });
const order = pos.order(terms, { url: "pos://lane-1/order-42" });
show(order.qr);                                   // the 402 terms, wire-encoded
const auth = await order.authorize(wireFromPhone); // free, instant, replay-guarded
if (auth.authorized) { handOverTheGoods(); await auth.capture(); }
```

`authorize` runs the full paywall core: the same signature presented at a
second lane is refused (`authorization_already_used`) before any facilitator
call, terms the terminal never offered are rejected, and a facilitator outage
reads as `{ authorized: false, reason: "facilitator_unavailable" }` — never a
throw. `capture({ amount })` settles less than the signed cap (`upto`); to
VOID, simply never capture. Runnable: `examples/pos-terminal.ts`.

Catch a misconfigured route at boot: `await createPaywall(options).verifySupported()`
asserts every `accepts` entry is advertised by the facilitator's `/supported`.

- **Replay guard (on by default).** Verification is an on-chain read — the
  nonce is only consumed once settlement is mined — so without a seller-side
  claim one signed header would buy N concurrent deliveries (the facilitator
  dedupes the N settles into one transfer). `check()` claims the scheme's
  `paymentId` before any facilitator call; a second presentation gets 402
  `authorization_already_used`. The default store is in-process and shared by
  every `paywall()` in the process (a header paid to `/a` is refused by `/b`);
  for several seller instances pass a shared `replayStore` (Redis `SET NX PX`). A
  payload's `resource.url`, when present, must also match this route.
- Facilitator down (`FacilitatorUnreachableError`) → `check()` returns a 503
  `facilitator_unavailable` decision, never throws; reasons echoed into a 402
  are restricted to known protocol codes; the `PAYMENT-SIGNATURE` header is
  capped at 8 KB before decoding.
- `settle: "async"` switches to the approve/capture split (POS-style): respond
  after verify, settle in the background, observe via `onSettled`. Who carries
  the risk between approval and capture is your policy decision.
- `settle: "after-handler"` settles only if your handler runs without throwing —
  so a handler that 500s never charges the buyer for nothing. Supported by the
  wrapper adapters (`withPaywall`/`withGate` on node, next, hono); hook-style
  express/fastify treat it as `sync`. `capture()` never rejects — a failed or
  unreachable settlement after the goods went out reaches you ONLY through
  `onSettled`, so treat that hook as mandatory accounting in this mode.
- `new FacilitatorClient(url, { apiKey, timeoutMs, allowInsecure })` — pass the
  turnkey facilitator's `SETTLE_API_KEY`; responses are shape-checked
  (`isValid`/`success` must be real booleans); plain `http://` to a
  non-loopback host warns.
- `facilitator` also accepts any object with `verify`/`settle` — including an
  embedded `createFacilitator()` from `@x402.kit/facilitator`.
- **Next.js** (App Router): `import { withPaywall } from "@x402.kit/seller/next"`
  wraps a route handler — `export const GET = withPaywall(options, async (req) => Response.json(...))`.
- **Fastify**: `import { paywall } from "@x402.kit/seller/fastify"` is a
  `preHandler` hook — `fastify.addHook("preHandler", paywall(options))` or
  per-route `{ preHandler: paywall(options) }`.
- No framework? `import { withPaywall } from "@x402.kit/seller/node"` wraps a
  plain `node:http` handler. The core (`createPaywall(...).check(request)`)
  works on web-standard Request/Response for everything else — so an adapter is
  ~15 dependency-free lines.

