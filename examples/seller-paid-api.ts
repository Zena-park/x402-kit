/**
 * Recipe: a paid API, and an agent that pays for it.
 *
 * SELLER — one middleware line turns a route into a paid one. A request with
 * no payment gets a 402; a valid payment is verified + settled and the handler
 * runs. `permit2Terms` works with any ERC-20 (no EIP-3009 required).
 *
 * BUYER (agent) — `wrapFetch` catches the 402, signs under a hard cap, and
 * retries. This is the M2M / agent-payment flow.
 *
 * Run: examples/run.sh (boots the local world, then runs this).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HEADER_PAYMENT_RESPONSE, decodeSettleResponseSafe } from "@x402.kit/core";
import { approvePermit2, wrapFetch } from "@x402.kit/buyer";
import { permit2Terms, withPaywall } from "@x402.kit/seller";
import { FACILITATOR, NETWORK, SELLER, TOKEN, balanceOf, buyer, buyerWallet, chainNow, fmt, publicClient } from "./lib.js";

const PORT = 4050;

async function main(): Promise<void> {
  // ── SELLER ────────────────────────────────────────────────────────────
  const terms = permit2Terms({ network: NETWORK, asset: TOKEN, payTo: SELLER, amount: "1000000000" }); // 1,000 KRW

  const handler = withPaywall(
    { accepts: [terms], facilitator: FACILITATOR },
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: "the paid resource" }));
    },
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(PORT, r));

  // ── BUYER (agent) ─────────────────────────────────────────────────────
  // One-time per token: approve Permit2 (skipped if already approved).
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN });

  const pay = wrapFetch(fetch, {
    signer: buyer,
    maxAmount: "5000000000", // hard spending cap — never signs above this
    assets: [TOKEN], // asset allowlist — required alongside maxAmount
    clock: chainNow, // demo only: sign against anvil's clock
  });

  const before = await balanceOf(buyer.address);
  const res = await pay(`http://127.0.0.1:${PORT}/data`);
  const settlement = decodeSettleResponseSafe(res.headers.get(HEADER_PAYMENT_RESPONSE) ?? "");

  console.log(`GET /data → ${res.status} ${JSON.stringify(await res.json())}`);
  console.log(`paid ${fmt(before - (await balanceOf(buyer.address)))}, settled tx ${settlement?.transaction}`);
  console.log("buyer sent zero transactions for the payment — signature only");

  server.close();
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
