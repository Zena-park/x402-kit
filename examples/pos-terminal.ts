/**
 * Recipe: an in-person POS terminal (authorize / capture split).
 *
 * No HTTP server — the 402 travels as a QR. The terminal AUTHORIZES with a
 * free, instant `verify` (hand over the goods), and CAPTURES on-chain with
 * `settle` afterwards, off the customer's critical path. Same shape as card
 * auth/capture.
 *
 * Run: examples/run.sh
 */

import {
  buildPaymentRequired,
  decodePaymentPayload,
  decodePaymentRequiredSafe,
  encodePaymentPayload,
  encodePaymentRequired,
} from "@x402kit/core";
import { approvePermit2, signPayment } from "@x402kit/buyer";
import { FacilitatorClient, permit2Terms } from "@x402kit/seller";
import { FACILITATOR, NETWORK, SELLER, TOKEN, buyer, buyerWallet, chainNow, fmt, publicClient } from "./lib.js";

async function main(): Promise<void> {
  const facilitator = new FacilitatorClient(FACILITATOR);
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN }); // one-time, per token

  // ── POS: build the 402 and show it as a QR ────────────────────────────
  const terms = permit2Terms({ network: NETWORK, asset: TOKEN, payTo: SELLER, amount: "3200000000" }); // 3,200 KRW
  const qr = encodePaymentRequired(buildPaymentRequired({ resource: { url: "pos://lane-1/order-42" }, accepts: [terms] }));

  // ── Phone: scan, sign (zero gas), send the payload back ───────────────
  const scanned = decodePaymentRequiredSafe(qr);
  if (!scanned.ok) throw new Error(scanned.error);
  const payload = await signPayment(scanned.value.accepts[0]!, { signer: buyer, now: await chainNow() });
  const wire = encodePaymentPayload(payload);

  const req = { x402Version: 2 as const, paymentPayload: decodePaymentPayload(wire), paymentRequirements: terms };

  // ── POS: verify = AUTHORIZE (instant, free) → give the goods ───────────
  const approved = await facilitator.verify(req);
  if (!approved.isValid) throw new Error(`declined: ${approved.invalidReason}`);
  console.log(`authorized ${fmt(BigInt(terms.amount))} (payer ${approved.payer}) → goods handed over`);

  // ── POS: settle = CAPTURE (async, gas is the facilitator's) ────────────
  const settled = await facilitator.settle(req);
  console.log(`captured on-chain, tx ${settled.transaction}`);
  // To VOID before capture: simply never call settle — no cost.
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
