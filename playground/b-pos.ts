/**
 * Chapter B — in-person payment, POS (scenario S5 — see the scenario map in
 * the README)
 *
 * The essence of in-person payment: the counter cannot wait seconds for
 * on-chain finality. So verify (free, instant, no chain writes) AUTHORIZES
 * and the goods change hands; settle (on-chain finality) CAPTURES later —
 * isomorphic to card auth/capture.
 *
 * There is no HTTP server here: the 402 object travelling by QR is simulated
 * with the codec strings themselves.
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
import { FACILITATOR, NETWORK, SELLER_ADDRESS, TOKEN, act, buyer, buyerWallet, chainNow, krw, publicClient } from "./world.js";

export async function chapterB(): Promise<void> {
  act("Chapter B · In-person payment (POS) — QR terms, authorize/capture split (S5)");
  const facilitator = new FacilitatorClient(FACILITATOR);

  // ─ The phone's one-time prerequisite: approve(token → Permit2) (no-op if another chapter did it)
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN });

  // ─ POS: no HTTP server — build the 402 object and present it as a QR
  const terms = permit2Terms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER_ADDRESS,
    amount: "3200000000", // two americanos = 3,200 KRW
  });
  const qr = encodePaymentRequired(
    buildPaymentRequired({ resource: { url: "pos://store-7/americano-x2" }, accepts: [terms] }),
  );
  console.log(`POS: presents the 402 terms as a QR (base64, ${qr.length} chars — pretend it's on screen)`);

  // ─ Customer's phone: scan, check the terms, sign (not a transaction — zero gas)
  const scanned = decodePaymentRequiredSafe(qr);
  if (!scanned.ok) throw new Error(scanned.error);
  const payload = await signPayment(scanned.value.accepts[0]!, { signer: buyer, now: await chainNow() });
  const wire = encodePaymentPayload(payload); // phone → POS (NFC/QR/HTTP — any channel)
  console.log(`phone: signed ${krw(BigInt(terms.amount))} → replies to the POS (base64, ${wire.length} chars)`);

  // ─ POS: verify = AUTHORIZE. Free, instant, no chain writes → hand over the goods here
  const approved = await facilitator.verify({
    x402Version: 2,
    paymentPayload: decodePaymentPayload(wire),
    paymentRequirements: terms,
  });
  if (!approved.isValid) throw new Error(`authorization failed: ${approved.invalidReason}`);
  console.log(`POS: ✅ authorized (payer=${approved.payer}) → ☕ goods handed over — the customer leaves`);

  // ─ Capture is async: on-chain finality after the customer is gone. Gas is the facilitator's
  const settled = await facilitator.settle({
    x402Version: 2,
    paymentPayload: decodePaymentPayload(wire),
    paymentRequirements: terms,
  });
  console.log(`POS (background): capture confirmed, tx ${settled.transaction}`);

  // ─ Narration
  console.log("┄ who carries the authorize→capture risk (balance draining in between) is operating policy, not code");
  console.log("┄ S8 (void): before capture, just don't settle — free. A post-capture refund is a reverse payment");
}
