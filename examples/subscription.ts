/**
 * Recipe: a fixed subscription (or installments) with pre-signed schedules.
 *
 * The buyer signs N standard payments in one ceremony (`signPaymentSchedule`),
 * each confined to its own billing window. The seller stores them and settles
 * one per period — the buyer can be offline forever after. Exposure is fixed
 * at signing (N × amount); an early charge is refused by the scheme's own time
 * check. No new scheme, no new on-chain code.
 *
 * Run: examples/run.sh
 */

import { approvePermit2, signPaymentSchedule } from "@x402.kit/buyer";
import {
  chargeScheduled,
  dueEntries,
  permit2Terms,
  validateSchedule,
} from "@x402.kit/seller";
import {
  FACILITATOR,
  NETWORK,
  SELLER,
  TOKEN,
  buyer,
  buyerWallet,
  chainNow,
  publicClient,
} from "./lib.js";

const PERIOD = 3600; // 1h periods for the demo — real ones are a month

async function main(): Promise<void> {
  await approvePermit2({
    walletClient: buyerWallet,
    publicClient,
    token: TOKEN,
  });

  // ── BUYER: sign the whole schedule once, hand it to the seller ─────────
  const terms = permit2Terms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER,
    amount: "2000000000",
  }); // 2,000 KRW/period
  const schedule = await signPaymentSchedule(terms, {
    assets: [terms.asset],
    signer: buyer,
    periods: { start: await chainNow(), periodSeconds: PERIOD, count: 3 },
    maxTotalAmount: "6000000000", // refuses to sign beyond 3 × 2,000 KRW
  });

  // ── SELLER: validate the untrusted submission, then store it ───────────
  const accepted = validateSchedule(JSON.parse(JSON.stringify(schedule)), [
    terms,
  ]);
  if (!accepted.ok) throw new Error(accepted.error);
  const installments = accepted.value; // persist these; the buyer may now go offline

  // ── SELLER cron: charge only what's due ────────────────────────────────
  const due = dueEntries(installments, await chainNow());
  const first = await chargeScheduled(due[0]!, FACILITATOR);
  console.log(
    `period 1 → ${first.success ? `settled ${first.transaction}` : first.errorReason}`,
  );

  const early = await chargeScheduled(installments[1]!, FACILITATOR); // not its period yet
  console.log(`period 2 charged early → refused: ${early.errorReason}`);

  console.log(
    `${dueEntries(installments, await chainNow()).length} installment(s) due now; the rest wait for their windows`,
  );
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
