# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the packages use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `@x402kit/core` — `exact` (EIP-3009 / Permit2) and `upto` schemes, payload
  codecs, verification with settle-path simulation, pending-receipt-aware
  settlement and on-chain reconciliation.
- `@x402kit/facilitator` — HTTP facilitator (`/verify`, `/settle`,
  `/supported`, `/health`) with token/payTo allowlists, idempotent settles,
  rate limiting and a Dockerfile.
- `@x402kit/seller` — paywall core plus express, fastify, hono, next and
  node:http adapters, replay guard, `upto` capture.
- `@x402kit/buyer` — `wrapFetch` / axios interceptor with per-payment and
  cumulative spending caps, asset/network allowlists, pre-signed schedules.

### Changed
- CI: single `npm run check` gate, SHA-pinned actions, e2e job on anvil.

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
