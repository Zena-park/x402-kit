# Security Policy

x402-kit handles signed payment authorizations and, in the facilitator, a hot
wallet that submits on-chain transactions. Please treat vulnerability reports
with care.

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Use GitHub's private vulnerability reporting:
<https://github.com/Zena-park/x402-kit/security/advisories/new>

Include a description, affected package/version, and reproduction steps or a
proof of concept if you have one. You can expect an acknowledgement within
72 hours and a status update within 7 days.

## Scope

- `@x402kit/core` — payload construction and verification (EIP-3009, Permit2,
  `upto`, `schedule`)
- `@x402kit/facilitator` — `/verify`, `/settle`, `/health`, `/supported`,
  signer and config handling, Dockerfile
- `@x402kit/seller` — paywall middleware and `X-PAYMENT` handling
- `@x402kit/buyer` — fetch/axios wrappers, spending caps, schedules

Out of scope: issues that require a compromised facilitator private key, the
`examples/`, `playground/` and `e2e/` directories (which intentionally use the
public Anvil/Hardhat dev keys), and third-party dependencies (report upstream).

## Supported versions

Only the latest published `0.x` release of each package receives fixes.

## Operator notes

- The facilitator's `PRIVATE_KEY` is a hot wallet. Fund it only with the gas
  it needs and rotate it if it is ever exposed.
- Run the facilitator behind a reverse proxy with TLS and rate limiting, and
  set `SETTLE_API_KEY` if it is reachable from untrusted networks.
