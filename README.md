# x402-kit

[![CI](https://github.com/Zena-park/x402-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Zena-park/x402-kit/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A kit for adding [x402](https://www.x402.org) payments to HTTP APIs: a
one-line seller middleware, a capped buyer fetch wrapper, and a self-hostable
facilitator. Works with any EIP-3009 token (USDC) and — via Permit2 — any plain
ERC-20. EOA, ERC-1271 smart-account, and ERC-6492 undeployed-account signers are
all first-class.

```
buyer (wrapFetch) ──402 / PAYMENT-SIGNATURE──▶ seller (paywall) ──verify / settle──▶ facilitator ──tx──▶ chain
                                                funds go straight to the seller's payTo; the buyer never sends a transaction
```

| Package | One line | What it does |
|---|---|---|
| `@x402kit/seller` | `app.use(paywall({ accepts, facilitator }))` | 402 + verify + settle middleware — hono · express · fastify · next · node — replay-guarded |
| `@x402kit/buyer` | `wrapFetch(fetch, { signer, maxAmount, assets })` | catch 402 → sign under per-payment + cumulative caps → retry |
| `@x402kit/facilitator` | `docker run x402kit/facilitator` | `/verify` `/settle` `/supported`, multi-chain, embeddable, API-key / payTo-scoped |
| `@x402kit/core` | — | spec-exact types · wire codec · pluggable schemes · `exact` built in |

Mint a token with [token-kit](https://github.com/Zena-park/token-kit), accept
payments in it with x402-kit.

## Guides

Start with **[docs/overview.md](docs/overview.md)** — one payment step by step,
who runs what, and which key each role holds. Then pick your role:

| You are… | Read |
|---|---|
| Building an **agent / bot / server** that pays unattended | [docs/agent-guide.md](docs/agent-guide.md) |
| Building a **browser dapp** where a human approves each payment | [docs/dapp-guide.md](docs/dapp-guide.md) |
| Running an **API that charges per call** (AI/LLM endpoint, data feed, premium content) | [docs/seller-guide.md](docs/seller-guide.md) |
| **Operating a facilitator** (you pay the gas) | [docs/operator-guide.md](docs/operator-guide.md) |

Each package's `README.md` is the option-by-option reference.

## Run it locally

Requirements: Node 20+, and [foundry](https://getfoundry.sh) (`anvil`) for the
on-chain demos.

```bash
npm install
npm test            # unit tests: spec fixtures, EIP-712 golden vectors
npm run playground  # narrated live demo — seller, buyer, and facilitator paying each other on a local chain
npm run e2e         # the same world as an automated harness
./examples/run.sh   # one runnable file per use case — see examples/README.md
```

## What's in the box

- **Any ERC-20.** Tokens with EIP-3009 settle directly; everything else goes
  through Permit2 (`permit2Terms` on the seller, one-time `approvePermit2` on the
  buyer — the only transaction a buyer ever sends).
- **Spending caps by construction.** The buyer wrapper refuses to sign without a
  per-payment cap and a token allowlist; a cumulative cap bounds unattended agents.
- **Open-amount payments (`upto`).** The buyer signs a cap, the seller settles
  the actual — usage-metered AI calls, fuel, deposits. `uptoTerms` + `capture({ amount })`
  (or a `Settlement-Overrides` response header); `$0` settles nothing; one cap, one draw.
- **Subscriptions and installments** with no new on-chain code: the buyer
  pre-signs one `exact` payment per billing window (`signPaymentSchedule`), the
  seller settles each when due (`dueEntries` + `chargeScheduled`).
- **A facilitator that refuses to be a free gas relay.** It won't start without
  an API key, a `payTo` allowlist, or an explicit opt-out; rate limits, gas
  ceilings, and token allowlists are on by default.

## Roadmap

- Variable-amount recurring, enforced by the payer's own smart account
  (spend-permissions-compatible).
- POS preset · MCP transport.

## License

Apache-2.0 — see [LICENSE](LICENSE). Implements the open [x402](https://www.x402.org)
protocol (x402-foundation/x402, Apache-2.0; its on-chain proxies MIT); no code is
copied from the reference implementation, which is used only as a dev-time
conformance oracle.
