/**
 * Scenario S4 (scenarios.ko.md) — exact/permit2 on anvil: pay with a plain-ERC-20 path
 * (no EIP-3009 needed), against the REAL Permit2 and x402ExactPermit2Proxy
 * bytecode vendored from Base mainnet (see bytecode/README.md).
 *
 * Proves:
 *   1. A payment without the one-time approve fails verify with
 *      permit2_allowance_required — the buyer-side fix, clearly attributed
 *   2. approvePermit2 is the buyer's ONLY gas-spending transaction, ever;
 *      calling it again is a no-op
 *   3. After the approve, payments are signature-only (zero gas), funds go
 *      straight to payTo through the canonical proxy
 *   4. settle is idempotent; verify rejects the consumed Permit2 nonce
 */

import assert from "node:assert/strict";
import { createWalletClient, http } from "viem";
import {
  ErrorReason,
  ErrorReasonExtra,
  X402_PERMIT2_PROXY_ADDRESS,
  buildPaymentRequired,
  exactScheme,
  isPermit2Payload,
  type FacilitatorRequest,
  type SettleResponse,
  type VerifyResponse,
} from "@x402kit/core";
import { approvePermit2 } from "@x402kit/buyer";
import { permit2Terms } from "@x402kit/seller";
import {
  RPC,
  SELLER,
  TOKEN,
  balanceOf,
  buyer,
  callFacilitator,
  chainClock,
  krw,
  publicClient,
  wonTerms,
} from "./fixtures.js";

async function main(): Promise<void> {
  // --- seller: permit2 terms — no EIP-712 token domain, works on ANY ERC-20 ---
  const requirements = permit2Terms({
    network: "eip155:31337",
    asset: TOKEN,
    payTo: SELLER,
    amount: "3000000000", // 3,000 KRW
  });
  const paymentRequired = buildPaymentRequired({
    resource: { url: "http://api.local/premium" },
    accepts: [requirements],
  });

  // --- buyer: sign. The handler routes to permit2 and names the canonical proxy ---
  const payload = await exactScheme.buildPayload(paymentRequired.accepts[0]!, {
    signer: buyer,
    now: await chainClock(),
  });
  if (!isPermit2Payload(payload.payload)) assert.fail("expected a permit2 payload");
  assert.equal(payload.payload.permit2Authorization.spender, X402_PERMIT2_PROXY_ADDRESS);
  const request: FacilitatorRequest = {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };

  // --- without the one-time approve, verify names the buyer-side fix ---
  const unapproved = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(unapproved.isValid, false);
  assert.equal(unapproved.invalidReason, ErrorReasonExtra.PERMIT2_ALLOWANCE_REQUIRED);
  console.log("[ok] pre-approve verify rejected:", unapproved.invalidReason);

  // --- one-time setup: approve(token -> Permit2). The buyer's only gas ever ---
  const walletClient = createWalletClient({ account: buyer, transport: http(RPC) });
  const approveTx = await approvePermit2({ walletClient, publicClient, token: TOKEN });
  assert.ok(approveTx, "approve tx expected");
  console.log("[ok] one-time Permit2 approve", approveTx);
  assert.equal(
    await approvePermit2({ walletClient, publicClient, token: TOKEN }),
    undefined,
    "second approve should be a no-op",
  );
  console.log("[ok] repeat approve is a no-op — allowance already sufficient");

  const amount = BigInt(requirements.amount);
  const [buyerBefore, sellerBefore, buyerGasBefore] = await Promise.all([
    balanceOf(buyer.address),
    balanceOf(SELLER),
    publicClient.getBalance({ address: buyer.address }),
  ]);

  // --- verify: now passes — free, instant, no chain writes ---
  const verified = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(verified.isValid, true, `verify failed: ${verified.invalidReason}`);
  console.log("[ok] verify approved", verified.payer);

  // --- settle: the facilitator drives the canonical proxy; gas is the facilitator's ---
  const settled = await callFacilitator<SettleResponse>("/settle", request);
  assert.equal(settled.success, true, `settle failed: ${settled.errorReason}`);
  assert.equal(settled.amount, requirements.amount, "settle response should echo the settled amount");
  console.log("[ok] settle confirmed", settled.transaction);

  const [buyerAfter, sellerAfter] = await Promise.all([balanceOf(buyer.address), balanceOf(SELLER)]);
  assert.equal(buyerBefore - buyerAfter, amount, "buyer debit mismatch");
  assert.equal(sellerAfter - sellerBefore, amount, "seller credit mismatch");
  console.log(`[ok] buyer  ${krw(buyerBefore)} -> ${krw(buyerAfter)}  (paid ${krw(amount)})`);
  console.log(`[ok] seller ${krw(sellerBefore)} -> ${krw(sellerAfter)}  (received directly via proxy)`);

  const buyerGasAfter = await publicClient.getBalance({ address: buyer.address });
  assert.equal(buyerGasBefore, buyerGasAfter, "buyer spent gas on the payment");
  console.log("[ok] payment gas spent by buyer: 0 — signature only after the one-time approve");

  // --- idempotency: resubmitting the same payment = same tx, no second transfer ---
  const again = await callFacilitator<SettleResponse>("/settle", request);
  assert.equal(again.success, true);
  assert.equal(again.transaction, settled.transaction, "idempotency broken — a different tx went out");
  assert.equal(await balanceOf(SELLER), sellerAfter, "double transfer occurred");
  console.log("[ok] settle idempotent — one transfer no matter how often submitted");

  // --- replay: the Permit2 unordered nonce is consumed on-chain ---
  const reverify = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(reverify.isValid, false);
  assert.equal(reverify.invalidReason, ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  console.log("[ok] replay rejected:", reverify.invalidReason);

  // --- terms hygiene: the same payload against eip3009-only terms is refused ---
  const eip3009Only = {
    ...requirements,
    extra: { assetTransferMethod: "eip3009" as const, ...wonTerms(requirements.amount).extra },
  };
  const crossMethod = await callFacilitator<VerifyResponse>("/verify", {
    ...request,
    paymentRequirements: eip3009Only,
  });
  assert.equal(crossMethod.isValid, false);
  assert.equal(crossMethod.invalidReason, ErrorReason.INVALID_PAYLOAD);
  console.log("[ok] permit2 payload against eip3009 terms rejected:", crossMethod.invalidReason);

  console.log("\nS4 passed — permit2 payment ran end to end against the canonical contracts");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
