# Security review

One record of what the kit guarantees, how that was checked, and what is
still open. Updated when a review happens; the history is the table at the
end.

## Threat model

Four parties, three of them possibly hostile at once:

| Party | Holds | Wants to |
|---|---|---|
| Buyer | a wallet, signs authorizations | pay less than agreed, pay once and be served twice, make the facilitator burn gas |
| Seller | the 402 terms, the `PAYMENT-RESPONSE` receipt | charge more than signed, redirect funds, drain a buyer's budget, replay a buyer's header |
| Facilitator | a hot wallet and an RPC | — (trusted by sellers who configure it; its exposure is to everyone else) |
| Network | the wire | swap chain / token / recipient / amount, replay across routes and chains |

Out of scope: a compromised facilitator key, a malicious RPC, and bugs in the
canonical Permit2 / x402 proxy contracts (vendored as bytecode for the e2e
run; audited in their own repositories).

## The one in-repo contract

`e2e/contracts/src/TestToken.sol` is the EIP-3009 token the e2e harness
deploys on anvil. It is never deployed to a public chain, but the kit's
eip3009 path trusts its state machine, so it gets the same treatment
token-kit's contracts do:

| Check | Tool | Where |
|---|---|---|
| Static analysis, fail on low | Slither (`slither.config.json`) | CI job `slither` |
| State-machine properties over all inputs: supply conservation, exact transfer amounts, no overdraw, allowance consumption, minter-only mint, used nonce always reverts, time window always enforced | Halmos (`halmos.toml`, `test/symbolic/`) | CI job `halmos (symbolic)` |
| Signature path concretely: valid transfer + `AuthorizationUsed`, replay, wrong signer, tampered amount | forge test (`test/TestToken.t.sol`) | CI job `contracts` |

## Guarantees, and where they are enforced

| Guarantee | Enforced in | Test |
|---|---|---|
| A signature verifies only for the exact `(chain, token, recipient, amount)` the seller demanded | `core` `checkEnvelope`, per-scheme match; EIP-712 `chainId` from the configured chain, never the wire | `core/test/conformance`, `permit2`, `upto` |
| Verify never passes for a payment that cannot settle | verify simulates the exact settle call from the settling account under the settle gas ceiling | `core/test/settlement-lifecycle` |
| Verify leaves a settle window | `minRemainingValiditySeconds` (default 6 s) on `validBefore` / `deadline` at verify, not at settle's re-verify | `settlement-lifecycle`, `upto` |
| One signature buys one delivery | seller replay store claimed before verify, released only on definite failure; process-wide default | `seller/test/security` |
| One on-chain transfer is credited to one payment | settlement ledger + EIP-3009 `AuthorizationUsed` proof in reconciliation | `settlement-lifecycle` |
| A pending broadcast is never resubmitted and never called a failure | `PendingReceiptError`, facilitator idempotency cache, reconcile-on-retry | `facilitator/test/resilience` |
| The buyer's budget counts what it signed, never what the seller says | `maxTotalAmount` reserved on the signed cap; `PAYMENT-RESPONSE.amount` is observational only | `buyer/test/upto`, `security` |
| The buyer signs only allowlisted tokens on allowlisted chains | mandatory `assets` (CAIP-19 entries scope by chain), optional `networks`, `maxValiditySeconds` clamp | `buyer/test/security` |
| The paid header is never forwarded off-origin | `redirect: "manual"` + origin pin on both fetch and axios | `buyer/test/security`, `axios` |
| The facilitator spends gas only for configured tokens above a floor, to allowlisted recipients, for authenticated callers | `termsPolicy` at verify and settle; `assertSettleExposure` refuses to boot an open relay; auth before rate limit | `facilitator/test/exposure`, `upto` |
| Secrets do not leak | key regex-validated then deleted from env and config; `/health` coarse; startup errors URL-redacted | `exposure` |

## Review history

| Date | Scope | Method | Outcome |
|---|---|---|---|
| 2026-08-22 | all four packages, pre-release | three independent model-driven reviews (core / facilitator / seller+buyer), each finding re-verified against the code by hand; adversarial focus on money movement | 1 high, 6 medium, 6 low found; all fixed the same day with regression tests (see CHANGELOG `[Unreleased] › Security`). Not fixed by design: `upto` caps are paid by default (documented; refuse with `schemes: [exactScheme]`). |

## Known limitations

- **Contract signers can grief gas.** ERC-1271 / ERC-6492 signers are
  attacker code; a signer that passes simulation and reverts on-chain costs
  the facilitator up to `maxSettleGas` / `maxErc6492SettleGas` per attempt.
  The ceilings bound the loss per attempt; rate limiting and `allowedPayTo`
  bound the rate. An allowlist of factories is the next step if this is
  observed.
- **`Settlement-Overrides` is read from whatever `Response` the handler
  returns.** A handler that proxies an upstream must strip the header first.
- **No external audit.** See `SECURITY.md › Status`.
