/**
 * Recipe: run your own facilitator, embedded.
 *
 * The facilitator is the only party that spends gas. You can run the turnkey
 * Docker image, or embed `createFacilitator()` in your own server — this shows
 * the embedded form. A token allowlist is the default; `"*"` is an explicit
 * opt-in because settling unknown tokens burns your gas on their code.
 *
 * SECURITY: `/settle` spends your gas, so an EXPOSED facilitator is a free gas
 * relay. The turnkey HTTP server refuses to start unless you set SETTLE_API_KEY,
 * scope recipients with `allowedPayTo`, or explicitly opt out with
 * `unauthenticatedSettle: true`; it also rate-limits per IP by default. Those
 * HTTP-layer controls do NOT apply to this embedded form — here nothing external
 * can reach verify/settle unless you expose them, so if you do, put the same
 * controls in front. See docs/operator-guide.md.
 *
 * This example is TYPE-CHECKED here; run it with a real RPC + signer key.
 */

import { createFacilitator, type ResolvedConfig } from "@x402.kit/facilitator";

const config: ResolvedConfig = {
  port: 4021,
  signerKey: "0x0000000000000000000000000000000000000000000000000000000000000000", // load from a secret manager
  chains: [
    {
      network: "eip155:8453", // Base mainnet, for example
      rpcUrl: "https://mainnet.base.org",
      tokens: [
        // allowlist the tokens you are willing to spend gas settling
        { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" }, // USDC
      ],
      // permit2Proxy / permit2Address / erc6492Settler overrides go here if needed
    },
  ],
};

const facilitator = createFacilitator(config);

// Embed however you like — here is the shape of the three endpoints:
export async function handleVerify(body: Parameters<typeof facilitator.verify>[0]) {
  return facilitator.verify(body); // POST /verify
}
export async function handleSettle(body: Parameters<typeof facilitator.settle>[0]) {
  return facilitator.settle(body); // POST /settle — spends gas; put auth in front
}
export function handleSupported() {
  return facilitator.supported(); // GET /supported
}

// For a zero-code deployment, skip all of the above and just:
//   docker run -v ./config.json:/config.json -e PRIVATE_KEY=... x402-kit/facilitator
