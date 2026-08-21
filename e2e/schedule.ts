/**
 * Pre-signed payment schedule e2e — fixed-amount recurring (subscription /
 * installments) with zero new on-chain code, on the same permit2 canonical
 * contracts.
 *
 * Proves:
 *   1. One signing ceremony authorizes exactly n payments — no open-ended pull
 *   2. An installment cannot settle before its period (the scheme's own time
 *      check refuses it), and settles once the chain reaches the window
 *   3. A settled installment is idempotent; the schedule's total exposure is
 *      bounded by construction
 */

import assert from "node:assert/strict";
import { createTestClient, http } from "viem";
import { ErrorReason } from "@x402.kit/core";
import { signPaymentSchedule } from "@x402.kit/buyer";
import {
  chargeScheduled,
  dueEntries,
  permit2Terms,
  validateSchedule,
} from "@x402.kit/seller";
import {
  FACILITATOR_URL,
  RPC,
  SELLER,
  TOKEN,
  balanceOf,
  buyer,
  chainClock,
  krw,
} from "./fixtures.js";

const anvil = createTestClient({ mode: "anvil", transport: http(RPC) });
const PERIOD = 3600; // 1h billing periods, warped through instantly

async function main(): Promise<void> {
  const now = await chainClock();

  // --- seller offers fixed-amount terms; buyer signs the WHOLE schedule once ---
  const terms = permit2Terms({
    network: "eip155:31337",
    asset: TOKEN,
    payTo: SELLER,
    amount: "2000000000", // 2,000 KRW per period
  });
  // Exposure is bounded at signing: one period too many and the buyer refuses
  await assert.rejects(
    signPaymentSchedule(terms, {
      assets: [terms.asset],
      signer: buyer,
      periods: { start: now, periodSeconds: PERIOD, count: 4 },
      maxTotalAmount: "6000000000",
    }),
    /exceeds maxTotalAmount/,
  );
  const payloads = await signPaymentSchedule(terms, {
    assets: [terms.asset],
    signer: buyer,
    periods: { start: now, periodSeconds: PERIOD, count: 3 },
    maxTotalAmount: "6000000000", // the commitment is exactly 3 × 2,000 KRW
  });
  console.log(
    "[ok] buyer signed 3 installments in one ceremony — exposure bounded at 6,000 KRW (a 4th refused)",
  );

  // --- seller accepts the schedule as an untrusted wire submission ---
  const accepted = validateSchedule(JSON.parse(JSON.stringify(payloads)), [
    terms,
  ]);
  if (!accepted.ok) throw new Error(`schedule rejected: ${accepted.error}`);
  const entries = accepted.value;
  console.log(
    "[ok] seller validated the schedule (terms match, unique identities, ordered windows)",
  );

  const [buyerBefore, sellerBefore] = await Promise.all([
    balanceOf(buyer.address),
    balanceOf(SELLER),
  ]);

  // --- period 1: due now → settles ---
  const due = dueEntries(entries, now);
  assert.equal(due.length, 1, "exactly one installment should be due");
  const first = await chargeScheduled(due[0]!, FACILITATOR_URL);
  assert.equal(first.success, true, `charge #1 failed: ${first.errorReason}`);
  console.log("[ok] charge #1 settled:", first.transaction);

  // --- period 2: NOT due — the scheme's own time check refuses it on-chain terms ---
  const early = await chargeScheduled(entries[1]!, FACILITATOR_URL);
  assert.equal(early.success, false);
  assert.equal(early.errorReason, ErrorReason.EXACT_VALID_AFTER);
  console.log(
    "[ok] early charge #2 refused by the scheme's time check:",
    early.errorReason,
  );

  // --- the next period arrives (warp chain time) → now it settles ---
  await anvil.increaseTime({ seconds: PERIOD });
  await anvil.mine({ blocks: 1 });
  const due2 = dueEntries(entries, await chainClock());
  assert.equal(due2.length, 1); // period 1 expired, period 2 due
  const second = await chargeScheduled(due2[0]!, FACILITATOR_URL);
  assert.equal(second.success, true, `charge #2 failed: ${second.errorReason}`);
  console.log(
    "[ok] charge #2 settled after its period arrived:",
    second.transaction,
  );

  // --- resubmitting a settled installment returns the same result, no double pull ---
  const again = await chargeScheduled(due[0]!, FACILITATOR_URL);
  assert.equal(again.success, true);
  assert.equal(again.transaction, first.transaction, "idempotency broken");

  const [buyerAfter, sellerAfter] = await Promise.all([
    balanceOf(buyer.address),
    balanceOf(SELLER),
  ]);
  assert.equal(buyerBefore - buyerAfter, 4000000000n, "buyer debit mismatch");
  assert.equal(
    sellerAfter - sellerBefore,
    4000000000n,
    "seller credit mismatch",
  );
  console.log(
    `[ok] two periods pulled: buyer ${krw(buyerBefore)} -> ${krw(buyerAfter)} (idempotent resubmit did not double-pull)`,
  );

  console.log(
    "\nSchedule passed — pre-signed fixed-amount recurring over plain exact/permit2",
  );
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
