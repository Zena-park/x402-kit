/**
 * Conformance S1 — self-contained e2e: one payment end to end on anvil,
 * driving the protocol core directly (no presets).
 *
 * Proves:
 *   1. The buyer only signs — zero transactions, zero gas
 *   2. Funds go straight to payTo
 *   3. settle is idempotent — resubmitting returns the same result, no second transfer
 *   4. verify rejects a consumed nonce (authorization_already_used)
 */

import assert from "node:assert/strict";
import {
  ErrorReasonExtra,
  buildPaymentRequired,
  exactScheme,
  type FacilitatorRequest,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { SELLER, balanceOf, buyer, callFacilitator, chainClock, krw, publicClient, wonTerms } from "./fixtures.js";

async function main(): Promise<void> {
  // --- seller: present the 402 terms (a POS would carry this object in a QR) ---
  const requirements = wonTerms("4500000000"); // 4,500 KRW
  const paymentRequired = buildPaymentRequired({
    resource: { url: "http://pos.local/item/7" },
    accepts: [requirements],
  });

  // --- buyer: sign (zero gas, not a transaction) ---
  const payload = await exactScheme.buildPayload(paymentRequired.accepts[0]!, {
    signer: buyer,
    now: await chainClock(),
  });
  const request: FacilitatorRequest = {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };

  const amount = BigInt(requirements.amount);
  const [buyerBefore, sellerBefore, buyerGasBefore] = await Promise.all([
    balanceOf(buyer.address),
    balanceOf(SELLER),
    publicClient.getBalance({ address: buyer.address }),
  ]);

  // --- verify: free and instant (an offline POS hands over the goods here) ---
  const verified = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(verified.isValid, true, `verify failed: ${verified.invalidReason}`);
  console.log("[ok] verify approved", verified.payer);

  // --- settle: on-chain finality. The facilitator pays the gas ---
  const settled = await callFacilitator<SettleResponse>("/settle", request);
  assert.equal(settled.success, true, `settle failed: ${settled.errorReason}`);
  console.log("[ok] settle confirmed", settled.transaction);

  const [buyerAfter, sellerAfter] = await Promise.all([balanceOf(buyer.address), balanceOf(SELLER)]);
  assert.equal(buyerBefore - buyerAfter, amount, "buyer debit mismatch");
  assert.equal(sellerAfter - sellerBefore, amount, "seller credit mismatch");
  console.log(`[ok] buyer  ${krw(buyerBefore)} -> ${krw(buyerAfter)}  (paid ${krw(amount)})`);
  console.log(`[ok] seller ${krw(sellerBefore)} -> ${krw(sellerAfter)}  (received directly)`);

  const buyerGasAfter = await publicClient.getBalance({ address: buyer.address });
  assert.equal(buyerGasBefore, buyerGasAfter, "buyer spent gas");
  console.log("[ok] buyer gas spent: 0 — never sent a transaction");

  // --- idempotency: resubmitting the same payment = same tx, no second transfer ---
  const again = await callFacilitator<SettleResponse>("/settle", request);
  assert.equal(again.success, true);
  assert.equal(again.transaction, settled.transaction, "idempotency broken — a different tx went out");
  assert.equal(await balanceOf(SELLER), sellerAfter, "double transfer occurred");
  console.log("[ok] settle idempotent — one transfer no matter how often submitted");

  // --- replay: verify rejects the consumed nonce ---
  const reverify = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(reverify.isValid, false);
  assert.equal(reverify.invalidReason, ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  console.log("[ok] replay rejected:", reverify.invalidReason);

  console.log("\nS1 passed — one payment ran end to end");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
