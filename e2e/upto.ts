/**
 * Scenario S6 (scenarios.ko.md) — upto on anvil: sign a CAP, settle the
 * ACTUAL, against the REAL Permit2 + x402UptoPermit2Proxy bytecode vendored
 * from Base mainnet (see bytecode/README.md).
 *
 * Proves:
 *   1. The facilitator advertises its address in /supported; the seller binds
 *      it into the terms; the buyer binds it into the signature
 *   2. verify judges the cap (worst case); settle moves only the actual
 *   3. One authorization settles ONCE — a second settle for a different amount
 *      returns the first result; the Permit2 nonce is consumed on-chain
 *   4. Over-cap is refused with the spec's reason code; $0 is a success with
 *      no transaction
 *   5. The seller paywall's capture({ amount }) drives the whole thing
 */

import assert from "node:assert/strict";
import { createWalletClient, http, type Address } from "viem";
import {
  ErrorReason,
  ErrorReasonExtra,
  HEADER_PAYMENT_SIGNATURE,
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  encodePaymentPayload,
  isUptoPayload,
  uptoScheme,
  type FacilitatorRequest,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402kit/core";
import { approvePermit2 } from "@x402kit/buyer";
import { createPaywall, uptoTerms } from "@x402kit/seller";
import { FACILITATOR_URL, RPC, SELLER, TOKEN, balanceOf, buyer, callFacilitator, chainClock, krw, publicClient } from "./fixtures.js";

async function main(): Promise<void> {
  // --- discovery: the facilitator tells sellers which address to bind ---
  const supported = (await (await fetch(`${FACILITATOR_URL}/supported`)).json()) as SupportedResponse;
  const kind = supported.kinds.find((k) => k.scheme === "upto" && k.network === "eip155:31337");
  assert.ok(kind, "facilitator should advertise upto");
  const facilitatorAddress = kind.extra?.["facilitatorAddress"] as Address;
  assert.ok(facilitatorAddress, "upto kind should carry extra.facilitatorAddress");
  console.log("[ok] /supported advertises upto bound to", facilitatorAddress);

  // --- seller: a cap of 5,000 KRW; the meter decides the real charge later ---
  const terms = uptoTerms({ network: "eip155:31337", asset: TOKEN, payTo: SELLER, maxAmount: "5000000000", facilitatorAddress });

  // --- buyer: one-time Permit2 approve (no-op if permit2.ts already ran), then sign the cap ---
  const walletClient = createWalletClient({ account: buyer, transport: http(RPC) });
  await approvePermit2({ walletClient, publicClient, token: TOKEN });
  const sign = async () => {
    const p = await uptoScheme.buildPayload(terms, { signer: buyer, now: await chainClock() });
    if (!isUptoPayload(p.payload)) assert.fail("expected an upto payload");
    assert.equal(p.payload.permit2Authorization.spender, X402_UPTO_PERMIT2_PROXY_ADDRESS);
    assert.equal(p.payload.permit2Authorization.witness.facilitator, facilitatorAddress);
    return p;
  };
  const payload = await sign();
  const request: FacilitatorRequest = { x402Version: 2, paymentPayload: payload, paymentRequirements: terms };

  // --- verify: against the cap ---
  const verified = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(verified.isValid, true, `verify failed: ${verified.invalidReason}`);
  console.log("[ok] verify approved the 5,000 KRW cap", verified.payer);

  const [buyerBefore, sellerBefore, buyerGasBefore] = await Promise.all([
    balanceOf(buyer.address),
    balanceOf(SELLER),
    publicClient.getBalance({ address: buyer.address }),
  ]);

  // --- settle: the meter read 1,234 KRW — requirements.amount carries the actual ---
  const actual = 1_234_000_000n;
  const settled = await callFacilitator<SettleResponse>("/settle", {
    ...request,
    paymentRequirements: { ...terms, amount: actual.toString() },
  });
  assert.equal(settled.success, true, `settle failed: ${settled.errorReason}`);
  assert.equal(settled.amount, actual.toString(), "settle response should report the ACTUAL amount");
  console.log("[ok] settled the actual", krw(actual), "tx", settled.transaction);

  const [buyerAfter, sellerAfter] = await Promise.all([balanceOf(buyer.address), balanceOf(SELLER)]);
  assert.equal(buyerBefore - buyerAfter, actual, "buyer debit should be the actual, not the cap");
  assert.equal(sellerAfter - sellerBefore, actual, "seller credit should be the actual");
  assert.equal(await publicClient.getBalance({ address: buyer.address }), buyerGasBefore, "buyer spent gas");
  console.log(`[ok] buyer ${krw(buyerBefore)} -> ${krw(buyerAfter)} — the unused ${krw(BigInt(terms.amount) - actual)} of the cap never moved`);

  // --- one authorization, one settlement: a different amount returns the first result ---
  const again = await callFacilitator<SettleResponse>("/settle", {
    ...request,
    paymentRequirements: { ...terms, amount: "4000000000" },
  });
  assert.equal(again.transaction, settled.transaction, "a second draw on one cap went out");
  assert.equal(again.amount, actual.toString());
  assert.equal(await balanceOf(SELLER), sellerAfter, "double draw occurred");
  console.log("[ok] second settle for a different amount → the first result, nothing moved");

  const reverify = await callFacilitator<VerifyResponse>("/verify", request);
  assert.equal(reverify.invalidReason, ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  console.log("[ok] Permit2 nonce consumed — replay rejected:", reverify.invalidReason);

  // --- over the cap: a fresh cap, a greedy seller ---
  const greedy = await callFacilitator<SettleResponse>("/settle", {
    x402Version: 2,
    paymentPayload: await sign(),
    paymentRequirements: { ...terms, amount: "5000000001" },
  });
  assert.equal(greedy.success, false);
  assert.equal(greedy.errorReason, ErrorReason.UPTO_SETTLEMENT_EXCEEDS_AMOUNT);
  console.log("[ok] over-cap refused:", greedy.errorReason);

  // --- $0: a fresh cap, nothing owed → success, no transaction ---
  const zeroPayload = await sign();
  const zero = await callFacilitator<SettleResponse>("/settle", {
    x402Version: 2,
    paymentPayload: zeroPayload,
    paymentRequirements: { ...terms, amount: "0" },
  });
  assert.deepEqual({ success: zero.success, transaction: zero.transaction, amount: zero.amount }, { success: true, transaction: "", amount: "0" });
  assert.equal(await balanceOf(SELLER), sellerAfter);
  // …and the same cap cannot be drawn afterwards within this facilitator
  const afterZero = await callFacilitator<SettleResponse>("/settle", {
    x402Version: 2,
    paymentPayload: zeroPayload,
    paymentRequirements: { ...terms, amount: "100" },
  });
  assert.equal(afterZero.transaction, "", "a $0-settled cap was drawn afterwards");
  console.log("[ok] $0 settlement: success, no tx, and the cap stays spent");

  // --- the seller-side story: paywall + after-handler + capture({ amount }) ---
  const settledVia: SettleResponse[] = [];
  const paywall = createPaywall({
    accepts: [terms],
    facilitator: FACILITATOR_URL,
    settle: "after-handler",
    onSettled: (r) => void settledVia.push(r),
  });
  const meterPayload = await sign();
  const decision = await paywall.check(
    new Request("http://api.local/meter", { headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(meterPayload) } }),
  );
  assert.equal(decision.paid, true);
  if (!decision.paid || !decision.capture) assert.fail("expected after-handler capture");
  const sellerBeforeMeter = await balanceOf(SELLER);
  const metered = 321_000_000n; // the handler measured 321 KRW of usage
  const { header, settlement } = await decision.capture({ amount: metered.toString() });
  assert.ok(header, "PAYMENT-RESPONSE header expected");
  assert.equal(settlement.amount, metered.toString());
  assert.equal((await balanceOf(SELLER)) - sellerBeforeMeter, metered);
  assert.equal(settledVia[0]?.amount, metered.toString());
  console.log("[ok] paywall.capture({ amount }) charged", krw(metered), "of a", krw(BigInt(terms.amount)), "cap");

  console.log("\nS6 passed — upto ran end to end against the canonical contracts");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
