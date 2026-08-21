# Operator guide — running a facilitator safely

This guide is for the **facilitator operator**. The facilitator is the
settlement agent of an x402 payment: it verifies buyer signatures forwarded by
sellers (`/verify`) and submits them as on-chain transactions (`/settle`).
**The gas for those transactions comes out of the operator's wallet.** Half of
this document is "how to run it"; the other half is "how to keep your gas from
leaking".

Seller-side configuration is in [`seller-guide.md`](./seller-guide.md).

---

## 0. Prerequisites

| Item | Notes |
|---|---|
| **Signer key** | Private key of the EOA that pays gas. Fund it with the native token (ETH etc.). **Do not reuse** a wallet that holds anything else — create a dedicated one. |
| **RPC URL** | One per chain. Public RPCs are rate-limited; use a paid or self-hosted node in production. |
| **Token list** | ERC-20 addresses you are willing to settle, with their EIP-712 domain (`name`, `version`). |
| Node 20+ or Docker | Runtime (the Docker image ships Node 22). |

---

## 1. Configuration

One file, `facilitator.config.json`:

```jsonc
{
  "port": 4021,                                  // default 4021
  "chains": [
    {
      "network": "eip155:8453",                  // CAIP-2. Only eip155:* (EVM) is supported
      "rpcUrl": "https://mainnet.base.org",
      "tokens": [
        {
          "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC on Base
          "name": "USD Coin",                    // EIP-712 domain — must match the token contract exactly
          "version": "2",
          "minAmount": "10000"                   // optional. Refuse settlements below this (atomic). Default "1"
        }
      ]
      // "erc6492Settler": "0x...",              // optional. First payments from undeployed smart wallets
      // "permit2Address": "0x...",              // optional. Default: canonical CREATE2 address
      // "permit2Proxy": "0x...",                // optional. Default: canonical x402ExactPermit2Proxy
      // "uptoPermit2Proxy": "0x...",            // optional. Default: canonical x402UptoPermit2Proxy
      // "maxSettleGas": 300000,                 // optional. Gas ceiling per settle tx. Default 300k
      // "maxErc6492SettleGas": 1500000          // optional. Ceiling for the 6492 deploy+settle path. Default 1.5M
    }
  ],
  "allowedPayTo": ["0xYourSellerAddress"],       // exposure control — see §3
  "rateLimitPerMinute": 300,                     // optional. POST requests per IP per minute. 0 disables. Default 300
  // "trustProxy": true,                         // optional. Rate-limit by the first x-forwarded-for hop. ONLY behind your own reverse proxy
  "maxInflightSettles": 16                       // optional. Concurrent settles per chain. Default 16
  // "signerKeyEnv": "PRIVATE_KEY",              // optional. Env var holding the key
  // "settleApiKeyEnv": "SETTLE_API_KEY"         // optional. Env var holding the API key
}
```

Every address and number is validated **at startup**. A typo exits with
`configuration error` (exit code 2) before any request is served.

### About `tokens`

- It is an **allowlist** by default. Tokens not listed are refused at `/verify`.
- `"tokens": "*"` accepts anything, but it is an **explicit opt-in**: whatever an
  unknown token's `transferWithAuthorization` does, you pay the gas for it.
- `name`/`version` double as the trusted domain for verification. If wrong,
  every payment in that token fails verify. They must equal what the seller's
  `erc3009Terms` reads off the token.
- The Permit2 path (terms built with `permit2Terms`) also requires the token
  address to be listed. `name`/`version` aren't used for verification there but
  the fields must be present.

---

## 2. Running

### 2a. From the monorepo (development)

```bash
PRIVATE_KEY=0x... FACILITATOR_CONFIG=./facilitator.config.json npm run facilitator
```

### 2b. As a package

```bash
PRIVATE_KEY=0x... FACILITATOR_CONFIG=./facilitator.config.json npx x402-facilitator
```

### 2c. Docker (recommended)

```bash
# build from the monorepo root
docker build -f packages/facilitator/Dockerfile -t x402-kit/facilitator .

docker run -d --name facilitator \
  -v "$PWD/facilitator.config.json:/config.json:ro" \
  -e PRIVATE_KEY=0x... \
  -e SETTLE_API_KEY=... \
  -p 4021:4021 \
  x402-kit/facilitator
```

The image runs as the non-root `node` user with `FACILITATOR_CONFIG=/config.json`
preset. A read-only mount (`:ro`) is all it needs.

### What happens at startup

1. Parse and validate the config file.
2. Read `PRIVATE_KEY` (or `signerKeyEnv`) → check the format → **delete it from `process.env`**. `SETTLE_API_KEY` is read and scrubbed the same way.
3. Exposure check (§3). Fail → exit.
4. Derive the signer account; the key is then also overwritten on the in-memory config object.
5. Call `eth_chainId` on every chain and check it matches `network`. Mismatch → exit.
6. Listen. The first log line reports signer address, auth mode, chains, tokens as JSON:

```json
{"t":"...","event":"started","port":4021,"signer":"0x...","settleAuth":"api-key","chains":[{"network":"eip155:8453","tokens":["0x8335..."]}]}
```

`settleAuth: "NONE"` means `unauthenticatedSettle: true` is on. You should never
see that in production.

### Smoke test

```bash
curl -s localhost:4021/health
# {"ok":true,"gas":{"eip155:8453":"ok"}}   — cached in memory for 10 s, so a state change shows with up to 10 s delay

curl -s localhost:4021/supported
# what the seller's verifySupported() reads — every configured (scheme, network) must appear.
# The `upto` kinds carry extra.facilitatorAddress (= your signer): sellers put it in uptoTerms,
# buyers bind it into the signature, and only THIS signer can draw on those caps.
```

---

## 3. Exposure controls — at least one is mandatory

`/settle` spends your gas. Left open on the internet, anyone holding an
allowlisted token can craft a "1 wei to myself" payment and settle it on your
gas forever. The server therefore **refuses to start** unless at least one of
these is set:

| Control | Where | Effect | Use when |
|---|---|---|---|
| **API key** | env `SETTLE_API_KEY` | `/verify` and `/settle` require `authorization: Bearer <key>` or `x-api-key: <key>` (constant-time compare). Missing → 401. | You have a handful of sellers you can hand a key to. **Default recommendation.** |
| **Recipient allowlist** | config `allowedPayTo` | Only settle payments whose recipient is listed. A stranger's self-transfer is refused. | Seller addresses are fixed. Combine with the API key. |
| **Explicit no-auth** | config `unauthenticatedSettle: true` | Run unprotected. | Local/test, or behind your own gateway (mTLS, VPN). |

The seller passes the key like this:

```ts
new FacilitatorClient("https://facilitator.example.com", { apiKey: process.env.FACILITATOR_API_KEY })
```

**Both together** is safest — even a leaked key can't move a single unit
outside `allowedPayTo`.

---

## 4. Defences that are on by default

No configuration needed. The numbers are the §1 fields if you ever need to tune them.

| Defence | Default | Stops |
|---|---|---|
| Per-IP token bucket (`rateLimitPerMinute`) | 300/min | POST flooding. Over the limit: 429 + `retry-after: 1`. |
| Per-chain in-flight ceiling (`maxInflightSettles`) | 16 | Nonces piling up behind a slow RPC. Over it: 503 `settle_overloaded` + `retry-after: 2`; nothing is broadcast. |
| Body validation | — | wrong content-type → 415; body over 64 KB → 413; invalid JSON → 400. |
| Settle gas ceiling (`maxSettleGas`) | 300k | Gas-burning malicious tokens / contract signers. **Applied to the verify simulation too**, so they fail verify before settle. |
| ERC-6492 gas ceiling (`maxErc6492SettleGas`) | 1.5M | Same, for the deploy+settle path. |
| Per-token minimum (`minAmount`) | 1 | Dust payments that cost you gas. |
| Body cap | 64 KB, `application/json` only | Oversized bodies. |
| Request / header timeouts | 15 s / 10 s | Slow-loris. |
| `eth_chainId` check at startup | always | Running against the wrong RPC. |
| Key scrubbing | always | Leaking the key via `/proc/<pid>/environ`, child processes, crash dumps. |
| No balances in `/health` | always | Reports only `ok` / `empty` / `unreachable`; never a number. |

---

## 5. Settlement correctness — things to know before an incident

The facilitator is **stateless**: no database, the chain is the only source of
truth. On top of that it follows these rules.

- **Nonces**: viem's `nonceManager` gives concurrent settles consecutive nonces. No collisions.
- **Re-verification**: every `/settle` re-runs verify right before submission. A payment whose balance vanished after verify is never broadcast.
- **Receipts**: only a receipt for **the exact hash that was broadcast** is trusted. A replacement tx on the same nonce proves nothing.
- **RPC error after broadcast** → reported as `settlement_pending` with the hash (HTTP 503, `retry-after: 10`), never as a definite failure. A seller retrying the same payload reconciles via `eth_getTransactionReceipt`.
- **Reverted, but the transfer landed** (someone front-ran the same signature) → reported as success with **that** transaction.
- **Idempotency**: settling the same payload again returns the same result. That cache lives in **process memory** — which is the reason for the constraint below.

### Deployment constraint: one signer key = one instance

Two replicas sharing a key both broadcast the same payment and one reverts
(wasted gas). To scale horizontally:

- create **several keys**, one per instance, and
- have the seller / load balancer route a given payment to the same instance (sticky), or
- split instances by chain.

---

## 6. Operations checklist

### Before deploying
- [ ] A fresh, dedicated signer wallet holding nothing else.
- [ ] The wallet is funded (`/health` reports `gas: ok`).
- [ ] `SETTLE_API_KEY` set and delivered to sellers over a secure channel.
- [ ] `allowedPayTo` lists your sellers' addresses.
- [ ] `tokens` is not `"*"`, and every token's `name`/`version` matches its on-chain domain.
- [ ] The startup log shows `settleAuth` ≠ `"NONE"`.
- [ ] TLS terminated in front (reverse proxy) — the facilitator itself speaks plain HTTP.
- [ ] Key and API key injected from a secret manager; not baked into the image, config file, or logs.

### While running
- [ ] `/health` wired to monitoring — `503` means gas empty (`empty`) or RPC down (`unreachable`).
- [ ] A balance alert on the signer wallet (`/health` deliberately doesn't report balances).
- [ ] Sustained `settle_overloaded` (503) → check RPC quality or `maxInflightSettles`.
- [ ] 429s from legitimate sellers → raise `rateLimitPerMinute`, or set `trustProxy: true` if they all arrive through one reverse proxy (then each seller gets its own bucket; unauthenticated callers already draw from a separate one).
- [ ] Logs (one JSON object per line) collected; alert on `event: "error"`.

### Key rotation
1. Start a new instance with a new key (fund the new wallet).
2. Move seller traffic to it.
3. Wait until the old instance has no settles in flight, then stop it.
4. Sweep the remaining gas out of the old wallet.

---

## 7. Embedding in the seller process

You can skip the separate server and run it inside the seller:

```ts
import { createFacilitator, loadConfig } from "@x402.kit/facilitator";
import { createPaywall } from "@x402.kit/seller";

const facilitator = createFacilitator(loadConfig("facilitator.config.json"));
const gate = createPaywall({ accepts, facilitator });   // no HTTP round trip
```

When embedded:
- The HTTP-layer protections (`unauthenticatedSettle`, `rateLimitPerMinute`, the API key) **do not apply** — nothing external can call it, so they aren't needed.
- The seller process now holds the gas key. Its security posture is the key's security posture.
- `loadConfig` still reads and scrubs the key (and API key) from `process.env`; `createFacilitator` then overwrites `signerKey` on the config object it was given, so don't reuse that object. You may also build a `ResolvedConfig` by hand if the key comes from a secret manager (see `examples/self-host-facilitator.ts`).
- `assertSettleExposure` is **not** called automatically when embedded — call it yourself if you later expose verify/settle over HTTP.

Custom schemes go in the second argument: `createFacilitator(config, [myScheme])`
(anything implementing `SchemeHandler` from `@x402.kit/core`).

---

## 8. Running the whole flow locally

Before touching a real chain, watch seller, buyer, and facilitator exchange real
payments on anvil. Nothing leaves your machine.

```bash
# requirements: Node 20+, foundry (anvil/cast/forge)
npm install
npm run playground          # A (paid API) → B (POS) → C (subscription)
npm run e2e                 # automated harness
./examples/run.sh           # isolated per-use-case recipes
```

---

## Where to go next

- `packages/facilitator/README.md` — reference-style list of every control.
- [`seller-guide.md`](./seller-guide.md) — what the sellers using this facilitator should read.
- `examples/self-host-facilitator.ts` — the embedded form as a type-checked recipe.
