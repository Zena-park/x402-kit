/**
 * Chapter B2 — open-amount in-person payment, `upto` (scenario S6 — see the
 * scenario map in the README)
 *
 * A fuel pump, a hotel deposit, a metered AI call: the price is known only
 * AFTER the work. Card networks solve it with a pre-authorization hold and a
 * later capture for the real figure. x402's `upto` scheme is the same idea
 * with one signature: the customer signs a CAP, the seller measures, and the
 * facilitator settles the ACTUAL — ≤ cap, once, and $0 if nothing was used.
 *
 * What is new against Chapter B:
 *   - terms come from `uptoTerms` and carry the facilitator's address — the
 *     customer binds it into the signature, so only THAT facilitator can draw
 *   - at settle time `paymentRequirements.amount` is the actual, not the cap
 *     (no new wire field — spec scheme_upto.md §5)
 *   - the unused part of the cap never moves; a second draw is impossible
 */

import {
  buildPaymentRequired,
  decodePaymentPayload,
  decodePaymentRequiredSafe,
  encodePaymentPayload,
  encodePaymentRequired,
  type SupportedResponse,
} from "@x402.kit/core";
import { approvePermit2, signPayment } from "@x402.kit/buyer";
import { FacilitatorClient, uptoTerms } from "@x402.kit/seller";
import type { Address } from "viem";
import { FACILITATOR, NETWORK, SELLER_ADDRESS, TOKEN, act, balanceOf, buyer, buyerWallet, chainNow, krw, publicClient } from "./world.js";

export async function chapterB2(): Promise<void> {
  act("Chapter B2 · Open-amount payment — sign a cap, settle the actual (S6, `upto`)");
  const facilitator = new FacilitatorClient(FACILITATOR);

  // ─ The phone's one-time prerequisite: approve(token → Permit2) (no-op if another chapter did it)
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN });

  // ─ Pump: which facilitator will draw on the cap? Ask it — /supported advertises its address
  const supported = (await (await fetch(`${FACILITATOR}/supported`)).json()) as SupportedResponse;
  const facilitatorAddress = supported.kinds.find((k) => k.scheme === "upto" && k.network === NETWORK)?.extra?.["facilitatorAddress"] as Address;
  console.log(`pump: facilitator ${facilitatorAddress} will settle — the customer's signature will name it`);

  // ─ Pump: terms with a CAP (a full tank at most), presented as a QR
  const terms = uptoTerms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER_ADDRESS,
    maxAmount: "100000000000", // cap: 100,000 KRW — "up to a full tank"
    facilitatorAddress,
  });
  const qr = encodePaymentRequired(
    buildPaymentRequired({ resource: { url: "pos://station-3/pump-7" }, accepts: [terms] }),
  );
  const cap = BigInt(terms.amount);
  console.log(`pump: presents upto terms — cap ${krw(cap)} — as a QR (${qr.length} chars)`);

  // ─ Customer's phone: scan, sign the CAP (zero gas). The witness binds pump + facilitator
  const scanned = decodePaymentRequiredSafe(qr);
  if (!scanned.ok) throw new Error(scanned.error);
  const payload = await signPayment(scanned.value.accepts[0]!, { signer: buyer, now: await chainNow() });
  const wire = encodePaymentPayload(payload);
  console.log(`phone: signed a ${krw(cap)} cap → pump (the customer authorized AT MOST this)`);

  // ─ Pump: verify = AUTHORIZE against the cap. The customer must be able to cover the worst case
  const approved = await facilitator.verify({
    x402Version: 2,
    paymentPayload: decodePaymentPayload(wire),
    paymentRequirements: terms,
  });
  if (!approved.isValid) throw new Error(`authorization failed: ${approved.invalidReason}`);
  console.log(`pump: ✅ cap authorized (payer=${approved.payer}) → ⛽ nozzle unlocked`);

  // ─ …the customer pumps 38,420 KRW of fuel and hangs up the nozzle…
  const actual = 38_420_000_000n;
  console.log(`pump: meter stopped at ${krw(actual)}`);

  // ─ Pump: settle = CAPTURE the actual. Same payload; only requirements.amount changes
  const before = await balanceOf(buyer.address);
  const settled = await facilitator.settle({
    x402Version: 2,
    paymentPayload: decodePaymentPayload(wire),
    paymentRequirements: { ...terms, amount: actual.toString() },
  });
  if (!settled.success) throw new Error(`capture failed: ${settled.errorReason}`);
  const after = await balanceOf(buyer.address);
  console.log(`pump: capture confirmed ${krw(BigInt(settled.amount ?? "0"))}, tx ${settled.transaction}`);
  console.log(`phone: ${krw(before)} → ${krw(after)} — the unused ${krw(cap - actual)} of the cap never moved`);

  // ─ One cap, one draw: a "second capture" for any other figure returns the first result
  const again = await facilitator.settle({
    x402Version: 2,
    paymentPayload: decodePaymentPayload(wire),
    paymentRequirements: { ...terms, amount: "1000000" },
  });
  console.log(`pump: a second capture attempt → same tx ${again.transaction === settled.transaction ? "(no second draw)" : "!!"}`);

  // ─ Narration
  console.log("┄ card pre-auth/capture, in one signature: the cap is the hold, the actual is the capture, $0 is a void");
  console.log("┄ only the facilitator named in the witness can draw — a stolen cap signature is useless elsewhere");
  console.log("┄ the same mechanism prices a usage-metered API: the handler measures tokens, sets Settlement-Overrides, the paywall captures");
}
