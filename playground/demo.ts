/**
 * x402-kit playground — a live, narrated usage example.
 *
 * One `npm run playground` and a seller, a buyer, and a facilitator exchange
 * real payments on a local anvil chain. Nothing leaves your machine.
 *
 *   Chapter A  Online one-shot payment — a paid API: 402 → one approve → signature-only payments
 *   Chapter B  In-person (POS) — the 402 travels as a QR; authorize (verify) / capture (settle) split
 *   Chapter B2 Open-amount (fuel, deposits, metered APIs) — `upto`: sign a cap, settle the actual
 *   Chapter C  Subscriptions & installments — pre-signed schedule: one ceremony, per-period settlement
 *
 * A single chapter: `npm run playground -- a` (a | b | b2 | c)
 * Each chapter's code IS the usage doc for its topic — read it top to bottom.
 */

import { chapterA } from "./a-online.js";
import { chapterB } from "./b-pos.js";
import { chapterB2 } from "./b2-upto.js";
import { chapterC } from "./c-schedule.js";

const chapters: Record<string, () => Promise<void>> = { a: chapterA, b: chapterB, b2: chapterB2, c: chapterC };

async function main(): Promise<void> {
  const pick = (process.argv[2] ?? "all").toLowerCase();
  if (pick !== "all" && !chapters[pick]) {
    throw new Error(`unknown chapter "${pick}" — a | b | b2 | c | all`);
  }
  for (const [name, run] of Object.entries(chapters)) {
    if (pick === "all" || pick === name) await run();
  }
  console.log("\nDone — each chapter's source (playground/*.ts) is the usage doc for its topic.");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
