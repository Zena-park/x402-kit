/**
 * Chapter A — online one-shot payment: a paid API (scenarios S1·S4 — see the
 * scenario map in the README)
 *
 * The seller makes an API paid with one middleware line; the buyer's fetch
 * wrapper meets the 402 and pays on its own. Payments take x402's permit2
 * transfer method — it never touches the token's EIP-3009 functions, so a
 * plain ERC-20 works, and after a single approve everything is signature-only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, decodePaymentRequiredSafe, decodeSettleResponseSafe } from "@x402kit/core";
import { approvePermit2, wrapFetch } from "@x402kit/buyer";
import { permit2Terms, withPaywall } from "@x402kit/seller";
import { FACILITATOR, NETWORK, SELLER_ADDRESS, TOKEN, act, balanceOf, buyer, buyerWallet, chainNow, krw, publicClient } from "./world.js";

const PORT = 4030;

export async function chapterA(): Promise<void> {
  act("Chapter A · Online one-shot payment — a paid API (S1 · S4)");

  // ─ Seller: permit2Terms needs no EIP-712 token domain, so it is synchronous
  //   and works for any ERC-20
  const terms = permit2Terms({
    network: NETWORK,
    asset: TOKEN,
    payTo: SELLER_ADDRESS,
    amount: "4500000000", // one premium report = 4,500 KRW
  });
  const premium = withPaywall(
    { accepts: [terms], facilitator: FACILITATOR },
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ report: "today's premium market report 📈" }));
    },
  );
  const server = createServer((req, res) => void premium(req, res));
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`seller: one paywall line made http://127.0.0.1:${PORT}/premium a paid route`);

  // ─ Buyer: a bare request gets a 402 — the header carries the payment terms
  const bare = await fetch(`http://127.0.0.1:${PORT}/premium`);
  const required = decodePaymentRequiredSafe(bare.headers.get(HEADER_PAYMENT_REQUIRED)!);
  if (!required.ok) throw new Error(`402 decode failed: ${required.error}`);
  const t = required.value.accepts[0]!;
  console.log(`bare request → HTTP ${bare.status}. terms: scheme=${t.scheme} · method=${String(t.extra?.assetTransferMethod)} · ${krw(BigInt(t.amount))} → ${t.payTo}`);

  // ─ permit2's only on-chain prerequisite: approve(token → Permit2), once
  //   (no-op when already approved)
  const approveTx = await approvePermit2({ walletClient: buyerWallet, publicClient, token: TOKEN });
  console.log(`one-time Permit2 approve: ${approveTx ?? "(already approved — skipped)"}`);

  // ─ Everything after is signatures: wrapFetch handles 402 → sign → retry
  const paidFetch = wrapFetch(fetch, {
    signer: buyer,
    maxAmount: "5000000000", // the safety pin — never signs above this
    assets: [TOKEN], // the asset allowlist — maxAmount alone is token-blind
    clock: chainNow, // sign against anvil time (other chapters warp it)
  });
  const before = await balanceOf(buyer.address);
  const paid = await paidFetch(`http://127.0.0.1:${PORT}/premium`);
  const receipt = decodeSettleResponseSafe(paid.headers.get(HEADER_PAYMENT_RESPONSE)!);
  console.log(`wrapFetch → HTTP ${paid.status}: ${JSON.stringify(await paid.json())}`);
  console.log(`receipt (PAYMENT-RESPONSE) tx: ${receipt?.transaction}`);
  console.log(`buyer balance ${krw(before)} → ${krw(await balanceOf(buyer.address))} — only signed; gas was the facilitator's`);

  // ─ Narration (same wire, different faces)
  console.log("┄ S2: a person buying content is this exact flow — only the signing UX (passkey wallet) differs");
  console.log("┄ S14: this token balance IS a prepaid wallet, and a seller accepting its own token is the gift-card model");

  server.close();
}
