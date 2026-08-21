/**
 * Recipe: a usage-metered API (`upto`) — the buyer signs a CAP, the handler
 * measures, the seller settles the ACTUAL.
 *
 * SELLER — `uptoTerms` names the cap and the facilitator that may draw on it
 * (read from the facilitator's /supported). With `settle: "after-handler"` the
 * paywall hands back a `capture()`; on plain node:http we drive it ourselves:
 * do the work, measure, `capture({ amount })`, THEN end the response — so the
 * PAYMENT-RESPONSE receipt carrying the actual reaches the buyer. (The hono /
 * next adapters do this for you via the `Settlement-Overrides` header; the
 * node `withPaywall` wrapper cannot, because your handler has already ended
 * the response by the time it captures.)
 *
 * BUYER (agent) — the same `wrapFetch` as seller-paid-api. `maxAmount` bounds
 * the CAP (the worst case); once the receipt reports the actual, the cumulative
 * budget is trued up to it — which is what lets the second call below go
 * through: a 9,000 KRW budget cannot hold two 5,000 KRW caps, but it holds one
 * cap plus the 321 KRW the first call actually cost.
 *
 * Run: examples/run.sh metered-api (boots the local world, then runs this).
 */

import { createServer } from "node:http";
import type { Address } from "viem";
import { HEADER_PAYMENT_RESPONSE, type SupportedResponse } from "@x402.kit/core";
import { approvePermit2, wrapFetch } from "@x402.kit/buyer";
import { applyDecision, createPaywall, requestFromNode, uptoTerms } from "@x402.kit/seller";
import { FACILITATOR, NETWORK, SELLER, TOKEN, balanceOf, buyer, buyerWallet, chainNow, fmt, publicClient } from "./lib.js";

const PORT = 4051;
const PRICE_PER_TOKEN = 1_000_000n; // 1 KRW per generated token (6 decimals)

async function main(): Promise<void> {
  // ── SELLER ────────────────────────────────────────────────────────────
  // Which facilitator may draw on the caps? Its /supported says so.
  const supported = (await (await fetch(`${FACILITATOR}/supported`)).json()) as SupportedResponse;
  const facilitatorAddress = supported.kinds.find((k) => k.scheme === "upto" && k.network === NETWORK)?.extra?.["facilitatorAddress"] as Address;

  const terms = uptoTerms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER,
    maxAmount: "5000000000", // cap: 5,000 KRW per call — "at most 5,000 generated tokens"
    facilitatorAddress,
  });
  const gate = createPaywall({
    accepts: [terms],
    facilitator: FACILITATOR,
    settle: "after-handler",
    onSettled: (r) => console.log(`seller: settled ${fmt(BigInt(r.amount ?? "0"))} (tx ${r.transaction || "none"})`),
  });

  const server = createServer(async (req, res) => {
    const decision = await gate.check(requestFromNode(req));
    if (!(await applyDecision(res, decision)) || !decision.paid) return; // 402 / 503 already written

    const generatedTokens = 321n; // …the model ran, this is what it produced…
    const actual = generatedTokens * PRICE_PER_TOKEN;

    // Capture BEFORE ending the response, so the receipt reaches the buyer
    const { header } = await decision.capture!({ amount: actual.toString() });
    if (header) res.setHeader(HEADER_PAYMENT_RESPONSE, header);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "…", usage: { tokens: Number(generatedTokens) } }));
  });
  await new Promise<void>((r) => server.listen(PORT, r));

  // ── BUYER (agent) ─────────────────────────────────────────────────────
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN }); // one-time per token

  const pay = wrapFetch(fetch, {
    signer: buyer,
    maxAmount: "5000000000", // bounds the CAP the agent will sign
    maxTotalAmount: "9000000000", // the whole budget — less than two caps, more than one cap + the first actual
    assets: [TOKEN],
    clock: chainNow, // demo only: sign against anvil's clock
    onPaid: (_t, settlement) => console.log(`buyer: paid ${fmt(BigInt(settlement?.amount ?? "0"))} of a ${fmt(BigInt(terms.amount))} cap`),
  });

  const before = await balanceOf(buyer.address);
  const res = await pay(`http://127.0.0.1:${PORT}/v1/answer`);
  console.log(`GET /v1/answer → ${res.status} ${JSON.stringify(await res.json())}`);
  console.log(`buyer balance: ${fmt(before)} → ${fmt(await balanceOf(buyer.address))} — the unused part of the cap never moved`);

  // Without the true-up the second 5,000 KRW cap would not fit (5,000 + 5,000 > 9,000); with it, 321 + 5,000 does
  const second = await pay(`http://127.0.0.1:${PORT}/v1/answer`);
  console.log(`second call → ${second.status} (budget trued up to the actual, not the cap)`);

  server.close();
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
