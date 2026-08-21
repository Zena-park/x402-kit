# Vendored runtime bytecode (local anvil e2e only)

Runtime bytecode of the three canonical contracts the `exact`/permit2 and
`upto` paths depend on, injected into anvil at their canonical addresses via
`anvil_setCode` (see `run.sh`). Vendored so the e2e is reproducible offline.

| File | Contract | Canonical address | Source |
|---|---|---|---|
| `permit2.hex` | Uniswap Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `eth_getCode` on Base mainnet (https://mainnet.base.org), 2026-08-21 |
| `x402-permit2-proxy.hex` | x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | same |
| `x402-upto-permit2-proxy.hex` | x402UptoPermit2Proxy | `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002` | same, 2026-08-22 |

Code hashes at vendoring time (keccak256 of the hex string as fetched):

- permit2: `0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed`
- proxy: `0xce6429c0bb49284660683287c0a8fe548a88379072327d026626909d202048b9`
- upto proxy: `0x4662dc27323421a3698be49ac95f7b0dba141c238d31ef543248d1a11f8d8eec`

Notes:

- Permit2's cached EIP-712 domain immutables carry chainId 8453 (Base), but
  its `DOMAIN_SEPARATOR()` rebuilds dynamically when `block.chainid` differs —
  so the same runtime bytecode verifies signatures correctly on anvil (31337).
- Verified before vendoring that the proxy bytecode contains (1) the
  `settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)`
  selector `0x13cd3b53`, (2) the witness typehash
  `keccak256("Witness(address to,uint256 validAfter)")`, and (3) the full
  witnessTypeString byte-identical to core's `PERMIT2_WITNESS_TYPE_STRING` —
  i.e. the kit's EIP-712 encoding matches the deployed artifact.
- Same verification for the upto proxy: (1) the
  `settle(((address,uint256),uint256,uint256),uint256,address,(address,address,uint256),bytes)`
  selector `0xff11e7b4`, (2) the witness typehash
  `keccak256("Witness(address to,address facilitator,uint256 validAfter)")`, and
  (3) the witnessTypeString byte-identical to core's
  `UPTO_PERMIT2_WITNESS_TYPE_STRING` are all present in the bytecode.

Provenance: these are runtime bytecodes of contracts deployed by the x402
project — sources in x402-foundation/x402 `contracts/evm/src` (MIT) and
Uniswap/permit2 (MIT). Vendored for local testing only; not part of any
published package.
