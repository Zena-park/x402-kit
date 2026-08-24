/**
 * Recipe: an in-person POS terminal (authorize / capture split).
 *
 * No HTTP server — the 402 travels as a QR. The terminal AUTHORIZES with a
 * free, instant verify (hand over the goods), and CAPTURES on-chain with
 * settle afterwards, off the customer's critical path. Same shape as card
 * auth/capture.
 *
 * `createPosTerminal` packages the whole counter side: QR encoding, the
 * replay guard (one signature buys one coffee, even across two lanes), the
 * terms-echo check, and capture. To VOID, simply never capture — no cost.
 *
 * Run: examples/run.sh pos-terminal (boots the local world, then runs this).
 */

import { decodePaymentRequiredSafe, encodePaymentPayload } from "@x402.kit/core";
import { approvePermit2, signPayment } from "@x402.kit/buyer";
import { permit2Terms } from "@x402.kit/seller";
import { createPosTerminal } from "@x402.kit/seller/pos";
import { FACILITATOR, NETWORK, SELLER, TOKEN, buyer, buyerWallet, chainNow, fmt, publicClient } from "./lib.js";

async function main(): Promise<void> {
  await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN }); // one-time, per token

  // ── POS: one terminal for the store, one order per sale ────────────────
  const pos = createPosTerminal({ facilitator: FACILITATOR });
  const order = pos.order(
    permit2Terms({ network: NETWORK, asset: TOKEN, payTo: SELLER, amount: "3200000000" }), // 3,200 KRW
    { url: "pos://lane-1/order-42" },
  );
  // order.qr goes on screen — base64 of the 402 terms

  // ── Phone: scan, sign (zero gas), send the payload back on any channel ──
  const scanned = decodePaymentRequiredSafe(order.qr);
  if (!scanned.ok) throw new Error(scanned.error);
  const payload = await signPayment(scanned.value.accepts[0]!, { signer: buyer, now: await chainNow() });
  const wire = encodePaymentPayload(payload);

  // ── POS: AUTHORIZE (instant, free, replay-guarded) → give the goods ─────
  const auth = await order.authorize(wire);
  if (!auth.authorized) throw new Error(`declined: ${auth.reason}`);
  console.log(`authorized ${fmt(3_200_000_000n)} → goods handed over`);

  // The same signature at a second lane is refused before any facilitator call
  const lane2 = pos.order(
    permit2Terms({ network: NETWORK, asset: TOKEN, payTo: SELLER, amount: "3200000000" }),
    { url: "pos://lane-2/order-42" },
  );
  const replayed = await lane2.authorize(wire);
  console.log(`replay at lane 2 → ${replayed.authorized ? "PAID TWICE?!" : `refused (${!replayed.authorized && replayed.reason})`}`);

  // ── POS: CAPTURE (async, on-chain, gas is the facilitator's) ───────────
  const settled = await auth.capture();
  console.log(`captured on-chain, tx ${settled.transaction}`);
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
