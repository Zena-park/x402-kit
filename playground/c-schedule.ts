/**
 * Chapter C — recurring: subscriptions & installments (scenarios S9·S11 — see
 * the scenario map in the README)
 *
 * The pre-signed schedule pattern: all installments are created in one signing
 * ceremony and handed to the seller. The buyer can then stay offline forever;
 * an early charge is refused by the scheme's own on-chain time check; and the
 * exposure is fixed at signing time as a total amount.
 * (Variable billing under a cap (S10) is being designed account-layer.)
 */

import { createServer } from "node:http";
import { approvePermit2, signPaymentSchedule } from "@x402.kit/buyer";
import {
  chargeScheduled,
  dueEntries,
  permit2Terms,
  validateSchedule,
  type ScheduleEntry,
} from "@x402.kit/seller";
import {
  FACILITATOR,
  NETWORK,
  SELLER_ADDRESS,
  TOKEN,
  act,
  anvil,
  balanceOf,
  buyer,
  buyerWallet,
  chainNow,
  krw,
  publicClient,
} from "./world.js";

const PORT = 4031;
const PERIOD = 3600; // 1h periods for the demo — real ones are a month

export async function chapterC(): Promise<void> {
  act(
    "Chapter C · Subscriptions & installments — pre-signed schedule (S9 · S11)",
  );

  // ─ Seller: subscription terms + a subscribe endpoint. All it stores is the payloads
  const terms = permit2Terms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER_ADDRESS,
    amount: "2000000000", // 2,000 KRW per period
  });
  let subscription: ScheduleEntry[] = [];
  const server = createServer((req, res) => {
    if (req.url !== "/subscribe" || req.method !== "POST")
      return void (res.writeHead(404), res.end());
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      // Never trust a schedule off the wire — validate terms match, payment
      // identity uniqueness, and window ordering
      const result = validateSchedule(JSON.parse(body), [terms]);
      if (!result.ok) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: result.error }));
      }
      subscription = result.value;
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ periods: result.value.length }));
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));

  // ─ Buyer: three installments in one signing ceremony (the permit2 approve
  //   is a no-op if chapter A already did it)
  await approvePermit2({
    walletClient: buyerWallet,
    publicClient,
    token: TOKEN,
  });
  const start = await chainNow();
  const schedule = await signPaymentSchedule(terms, {
    assets: [terms.asset],
    signer: buyer,
    periods: { start, periodSeconds: PERIOD, count: 3 },
    maxTotalAmount: "6000000000", // hard cap: 3 × 2,000 KRW. A larger schedule refuses to sign
  });
  const subscribed = await fetch(`http://127.0.0.1:${PORT}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(schedule),
  });
  console.log(
    `subscribe → HTTP ${subscribed.status} ${JSON.stringify(await subscribed.json())} — the buyer can now stay offline`,
  );

  // ─ Seller cron: pick only what is due and settle through the standard /settle
  const sellerBefore = await balanceOf(SELLER_ADDRESS);
  const due1 = dueEntries(subscription, await chainNow());
  const charge1 = await chargeScheduled(due1[0]!, FACILITATOR);
  console.log(
    `period 1 charge → ${charge1.success ? `✅ settled ${charge1.transaction}` : charge1.errorReason}`,
  );

  const early = await chargeScheduled(subscription[1]!, FACILITATOR); // period 2 hasn't arrived
  console.log(
    `early period-2 charge → ❌ ${early.errorReason}  (the scheme's own time check refuses on-chain terms)`,
  );

  await anvil.increaseTime({ seconds: PERIOD });
  await anvil.mine({ blocks: 1 });
  console.log("… one period passes (anvil time warp) …");

  const due2 = dueEntries(subscription, await chainNow());
  const charge2 = await chargeScheduled(due2[0]!, FACILITATOR);
  console.log(
    `period 2 charge → ${charge2.success ? `✅ settled ${charge2.transaction}` : charge2.errorReason}`,
  );

  const replay = await chargeScheduled(due1[0]!, FACILITATOR);
  console.log(
    `period 1 resubmitted → same tx ${replay.transaction === charge1.transaction ? "(idempotent — no double pull)" : "⚠️"}`,
  );

  const [sellerAfter, remaining] = await Promise.all([
    balanceOf(SELLER_ADDRESS),
    chainNow().then((t) => dueEntries(subscription, t + PERIOD).length),
  ]);
  console.log(
    `seller income ${krw(sellerBefore)} → ${krw(sellerAfter)} · ${remaining} installment(s) left — nothing beyond the signed total can ever leave`,
  );
  console.log(
    "┄ S11 (installments) is the same mechanism with different numbers: amount × n",
  );
  console.log(
    "┄ 'any amount under a cap' billing (S10, post-paid utilities) is being designed account-layer — the payer's smart account enforces the cap",
  );

  server.close();
}
