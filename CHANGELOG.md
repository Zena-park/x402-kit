# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the packages use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-08-24

MCP transport — paid tools over the Model Context Protocol
(spec `transports-v2/mcp.md`), wire-compatible with the official `@x402/mcp`
SDK (interop e2e pays in both directions through the kit facilitator).

### Added
- `@x402.kit/core` — MCP wire codec: `_meta` keys, payment-required tool-result
  assembly/extraction, plain-JSON settle receipts (`buildMcpPaymentRequired`,
  `extractMcpPayment*`, `attachMcp*`).
- `@x402.kit/seller/mcp` — `paidTool()` wraps one `registerTool` tuple with the
  paywall; `sync` and `after-handler` modes; a definite settlement failure
  after execution withholds the tool's content (spec rule); upto actuals via
  the `x402kit/settlement-overrides` result meta.
- `@x402.kit/buyer/mcp` — `wrapMcpClient()` pays payment-required tool results
  under the same caps vocabulary as `wrapFetch` (one paid retry, budget counts
  what was signed).
- `examples/paid-mcp-tool.ts` and two e2e scenarios (`mcp`, `mcp-interop`).
- `@x402.kit/seller/pos` — `createPosTerminal()`: the in-person
  authorize/capture recipe as a preset — QR terms, replay-guarded
  `authorize(wire)`, `capture({ amount })`, void by simply not capturing.

### Changed
- `createPaywall` now also exposes the transport-free `checkPayment()` core;
  the HTTP `check()` behavior is byte-identical.
- `preparePayment` (buyer) also returns the signed payload as an object.
- Removed the stale "budget true-up" wording from docs and the metered-api
  example (the budget counts the signed cap; the example now demonstrates
  budget exhaustion).

## [0.1.0] - 2026-08-22

First public release, published on npm as `@x402.kit/*`.

### Added
- `@x402.kit/core` — `exact` (EIP-3009 / Permit2) and `upto` schemes, payload
  codecs, verification with settle-path simulation, pending-receipt-aware
  settlement and on-chain reconciliation.
- `@x402.kit/facilitator` — HTTP facilitator (`/verify`, `/settle`,
  `/supported`, `/health`) with token/payTo allowlists, idempotent settles,
  rate limiting and a Dockerfile.
- `@x402.kit/seller` — paywall core plus express, fastify, hono, next and
  node:http adapters, replay guard, `upto` capture.
- `@x402.kit/buyer` — `wrapFetch` / axios interceptor with per-payment and
  cumulative spending caps, asset/network allowlists, pre-signed schedules.

### Changed
- CI: single `npm run check` gate, SHA-pinned actions, e2e job on anvil.
- `e2e/contracts` is a full foundry project (forge-std submodule) with forge
  tests, Slither and Halmos symbolic properties for the e2e token, each its
  own CI job.

### Security
- Buyer budget (`maxTotalAmount`) counts the signed amount/cap only; the
  seller-reported charge never restores it.
- Reconciliation binds an external settlement to one payment (settlement
  ledger + EIP-3009 `AuthorizationUsed` proof).
- Verify requires a minimum remaining validity window so a payment cannot
  pass verify and expire before settle.
- Seller replay guard is shared across paywalls in a process.
- Facilitator applies the `minAmount` floor at settle, checks auth before
  rate limiting, and supports `trustProxy`.

[Unreleased]: https://github.com/Zena-park/x402-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Zena-park/x402-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Zena-park/x402-kit/releases/tag/v0.1.0
