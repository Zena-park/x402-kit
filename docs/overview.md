# Overview — who runs what

Read this page first, then pick your role's guide at the bottom.

## 1. One payment

`402 Payment Required` is an HTTP status code, like 404. A **server sends it to
a client**. So the buyer is a client (an agent script, a browser tab, a cron
job); the servers that must be running are the seller's API and the facilitator.

```
buyer                                   seller                       facilitator            chain
  │── GET /premium ─────────────────────▶│                                │                    │
  │◀── 402 + PAYMENT-REQUIRED ───────────│  "10000 of token X to addr Z"  │                    │
  │   (sign the terms — no tx, no gas)   │                                │                    │
  │── GET /premium + PAYMENT-SIGNATURE ─▶│── POST /verify, /settle ──────▶│── transfer tx ────▶│
  │                                      │◀── tx hash ────────────────────│   (pays the gas)   │
  │◀── 200 + PAYMENT-RESPONSE ───────────│  handler ran; header = tx hash │                    │
```

- The token moves **buyer → seller's `payTo`** in one on-chain transfer. It never passes through the facilitator; the facilitator only pays the gas.
- `wrapFetch` (buyer) = "catch the 402, sign, resend". `paywall` (seller) = "send the 402, forward the signature, serve after payment". The facilitator = "verify, broadcast, pay gas".

## 2. Three roles

| | **Buyer** | **Seller** | **Facilitator operator** |
|---|---|---|---|
| You run | your app / agent / frontend | your HTTP API | one Docker container (`x402-kit/facilitator`) |
| Package | `@x402.kit/buyer` | `@x402.kit/seller` | `@x402.kit/facilitator` |
| Key you hold | the paying wallet's key (or the user's browser wallet) | **none** | a **gas** wallet's key — it never holds the token |
| RPC | only for the one-time Permit2 approve | no | yes, one per chain |
| Sends transactions | no — signs only | no | yes, every settlement |
| One line of config | `wrapFetch(fetch, { signer, maxAmount, maxTotalAmount, assets })` | `paywall({ accepts, facilitator })` | `facilitator.config.json` + `PRIVATE_KEY` + `SETTLE_API_KEY` |

All three packages sit on `@x402.kit/core` (types, wire codec, schemes, signature verification).

## 3. Which roles are yours?

| You are… | You run | Everyone else |
|---|---|---|
| **Selling an API** | seller middleware **+** a facilitator (your own gas wallet, on a private network, called only by your API with the API key) | buyers are strangers; they run nothing of yours |
| **Building an agent that buys** | the buyer side only | the seller's 402 tells you the terms; their facilitator is their problem |
| **A platform with many sellers** | one facilitator for all of them — `allowedPayTo` lists every seller, one API key per seller | sellers run only the middleware |
| **Developing locally** | `npm run playground` — anvil + all three roles on one machine, real payments, nothing leaves the box | — |

Small deployments can embed the facilitator in the API process instead of
running a second container (`createFacilitator()` — operator guide §7). The API
server then holds the gas key.

## 4. Two kinds of buyer, same wire

| | Agent / bot / server | Browser dapp |
|---|---|---|
| Who approves | nobody — the process signs under caps | the user, in the wallet popup |
| Signer | `privateKeyToAccount(KEY)` | wallet client → 5-line adapter |
| Must-have | `maxTotalAmount` (cumulative budget) | the call behind a user gesture |

Sellers and facilitators cannot tell them apart.

## 5. Two kinds of token, decided by the seller's terms

| Token | Example | Buyer's one-time setup | Seller builds terms with |
|---|---|---|---|
| EIP-3009 | USDC | none | `erc3009Terms()` |
| Plain ERC-20 | almost everything else | `approvePermit2()` once per token — the only gas a buyer ever spends | `permit2Terms()` |

Either way the facilitator must allowlist the token in its config. A second
axis is **pricing**: `exact` (a fixed price, signed as-is) or `upto` (the buyer
signs a cap, the seller settles the actual — Permit2 only).

## 6. Your guide

| Role | Guide |
|---|---|
| Agent / bot / server that pays | [agent-guide.md](./agent-guide.md) |
| Browser dapp that pays | [dapp-guide.md](./dapp-guide.md) |
| API that charges | [seller-guide.md](./seller-guide.md) |
| Facilitator operator | [operator-guide.md](./operator-guide.md) |

Reference: `packages/*/README.md` (every option) · `examples/` (one runnable file per use case) · `playground/` (narrated end-to-end demo).
