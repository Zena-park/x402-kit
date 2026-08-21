# @x402kit/facilitator

A self-hostable x402 facilitator: `/verify`, `/settle`, `/supported`,
`/health`, speaking spec §7 exactly — standard clients connect by changing
only the URL. Multi-chain, token-allowlisted, idempotent settlement,
re-verification before every settle. Stateless: the chain is the source of
truth, so it runs with no database.

## Turnkey

```jsonc
// facilitator.config.json
{
  "chains": [{
    "network": "eip155:84532",
    "rpcUrl": "https://sepolia.base.org",
    "tokens": [{ "address": "0x...", "name": "My Token", "version": "1" }]
  }]
}
```

```bash
PRIVATE_KEY=0x... FACILITATOR_CONFIG=./facilitator.config.json npx x402-facilitator
# or
docker build -f packages/facilitator/Dockerfile -t x402kit/facilitator .
docker run -v ./facilitator.config.json:/config.json -e PRIVATE_KEY=0x... -p 4021:4021 x402kit/facilitator
```

The signer key pays the gas. `tokens` is an allowlist by default — `"tokens": "*"`
is an explicit opt-in, because settling unknown tokens burns your gas on
whatever their `transferWithAuthorization` does. The configured `name`/`version`
double as the trusted EIP-712 domain for verification.

## Schemes

`exact` (eip3009 and permit2) and `upto` (sign a cap, settle the actual —
Permit2 only) are built in. For `upto` the facilitator advertises its own
address in `/supported` (`kinds[].extra.facilitatorAddress`); sellers bind it
into their terms and buyers into the signature, so only this signer can draw on
a cap. The settle-time `paymentRequirements.amount` is the actual charge (≤ the
signed cap; `0` settles nothing and broadcasts nothing). Idempotency for `upto`
ignores the amount — one authorization settles once whatever figure is asked —
and the token `minAmount` floor is judged on the cap at verify, not on the
actual at settle. Override the proxy with `uptoPermit2Proxy` per chain (the
default is the canonical `x402UptoPermit2Proxy`, validated to hold code).

## Exposure controls

`/settle` spends the operator's gas, so an exposed facilitator is a free gas
relay: anyone holding an allowlisted token could settle a tiny transfer to
themselves on your gas. The server therefore **refuses to start** unless at
least one of these is set:

| Control | Where | Effect |
|---|---|---|
| `SETTLE_API_KEY` (env; name via `settleApiKeyEnv`) | env | `POST /verify` and `/settle` require `authorization: Bearer <key>` or `x-api-key` (constant-time compare). `@x402kit/seller`'s `FacilitatorClient` sends it via `{ apiKey }`. |
| `allowedPayTo: ["0x…"]` | config | Only settle to your own sellers' addresses. |
| `unauthenticatedSettle: true` | config | Explicit opt-out — local/test, or behind your own gateway. |

Also on by default: a per-IP token bucket on the POST endpoints
(`rateLimitPerMinute`, default 300, `0` disables); an in-flight ceiling per
chain (`maxInflightSettles`, default 16 — beyond it callers get
`settle_overloaded` / HTTP 503 + `retry-after`, nothing is broadcast); a gas
ceiling per settlement tx (`maxSettleGas` 300k, `maxErc6492SettleGas` 1.5M —
applied to the verify simulation too, so a gas-burning contract signer fails
verify instead of costing you a block); a per-token `minAmount` floor; a
startup `eth_chainId` check against each configured network; `/health` reports
coarse gas status (`ok`/`empty`/`unreachable`), never balances; and the signer
key is scrubbed from `process.env` and the config object once the account is
derived. Bodies are capped at 64 KB and must be `application/json`.

Settlement correctness: the facilitator's account uses viem's `nonceManager`
(concurrent settles get consecutive nonces instead of colliding), a receipt is
only trusted if it is for the hash that was broadcast (a replacement tx on the
same nonce proves nothing), any RPC error after broadcast is reported as
`settlement_pending` with the hash (never as a definite failure), a retry
against a pending entry reconciles via `eth_getTransactionReceipt`, and a
reverted settle whose signed transfer landed anyway (someone front-ran it)
is reported as success with THAT transaction.

The settle idempotency cache is per process — **run one instance per signer
key**. Two replicas sharing a key both broadcast the same payment and one
reverts. The permit2 proxy override, if set, must point at a real deployed
`x402ExactPermit2Proxy` on that chain — a wrong address is rejected at verify
(the spender-equality and proxy-code checks fail closed), never settled silently.

## Embedded

```ts
import { createFacilitator, loadConfig } from "@x402kit/facilitator";

const facilitator = createFacilitator(loadConfig("facilitator.config.json"));
// facilitator.verify(req) / facilitator.settle(req) — plug into any server.
// It satisfies @x402kit/seller's FacilitatorLike, so a seller can run its own:
// createPaywall({ accepts, facilitator })
```

Custom schemes: `createFacilitator(config, [myScheme])` — anything implementing
`SchemeHandler` from `@x402kit/core`.
