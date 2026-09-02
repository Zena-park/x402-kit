/**
 * Conformance S1-full — all three roles through the shipped presets:
 *
 *   @x402.kit/buyer (wrapFetch)  ->  @x402.kit/seller (withPaywall, node:http)
 *                               ->  @x402.kit/facilitator (HTTP)
 *
 * pay.ts proves the protocol core; this proves the one-line developer
 * surface: a seller wraps a handler, a buyer wraps fetch, and a payment
 * clears end to end with the PAYMENT-RESPONSE header on the final response.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HEADER_PAYMENT_RESPONSE, decodeSettleResponse } from "@x402.kit/core";
import { withPaywall } from "@x402.kit/seller/node";
import { wrapFetch } from "@x402.kit/buyer";
import { FACILITATOR_URL, TOKEN, buyer, chainClock, wonTerms } from "./fixtures.js";

const terms = wonTerms("1200000000"); // 1,200 KRW

async function main(): Promise<void> {
  // --- seller: one wrapped handler on plain node:http ---
  const server = createServer(
    withPaywall({ accepts: [terms], facilitator: FACILITATOR_URL }, (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ article: "premium content" }));
    }),
  );
  await new Promise<void>((resolve) => server.listen(4030, resolve));

  try {
    // --- buyer: one wrapped fetch ---
    const paidFetch = wrapFetch(fetch, {
      signer: buyer,
      maxAmount: "2000000000", // cap: 2,000 KRW
      assets: [TOKEN], // only pay in the token under test
      clock: chainClock, // the `clock` option — sign against chain time; production keeps the default wall clock
    });

    const res = await paidFetch("http://127.0.0.1:4030/article");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { article: "premium content" });

    const settlement = decodeSettleResponse(res.headers.get(HEADER_PAYMENT_RESPONSE)!);
    assert.equal(settlement.success, true);
    assert.match(settlement.transaction, /^0x[0-9a-f]{64}$/);
    console.log("[ok] buyer paid through the presets, tx:", settlement.transaction);

    // --- a second purchase signs a fresh nonce and clears independently ---
    const res2 = await paidFetch("http://127.0.0.1:4030/article");
    assert.equal(res2.status, 200);
    const settlement2 = decodeSettleResponse(res2.headers.get(HEADER_PAYMENT_RESPONSE)!);
    assert.notEqual(settlement2.transaction, settlement.transaction);
    console.log("[ok] second purchase settled separately, tx:", settlement2.transaction);

    // --- the spending cap holds: a capped buyer never signs ---
    const cappedFetch = wrapFetch(fetch, {
      signer: buyer,
      maxAmount: "1000000", // 1 KRW — below the price
      assets: [TOKEN],
      clock: chainClock,
    });
    const refused = await cappedFetch("http://127.0.0.1:4030/article");
    assert.equal(refused.status, 402);
    console.log("[ok] capped buyer refused to sign — got the 402 back");

    console.log("\nS1-full passed — buyer/seller/facilitator presets interoperate");
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
