/**
 * Buyer side of upto: the cap is what the caps bound, the cumulative budget
 * counts the signed cap (never the seller-reported charge), and malformed upto terms are skipped
 * (with the scheme's reason) instead of throwing out of fetch.
 */

import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  buildPaymentRequired,
  decodePaymentPayload,
  encodePaymentRequired,
  encodeSettleResponse,
  type PaymentRequirements,
  type UptoPayload,
} from "@x402kit/core";
import { wrapFetch } from "../src/index.js";

const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const FACILITATOR = "0x1111111111111111111111111111111111111111";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function capTerms(cap: string): PaymentRequirements {
  return {
    scheme: "upto",
    network: "eip155:84532",
    amount: cap,
    asset: ASSET,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR },
  };
}

function req402(accepts: PaymentRequirements[]): Response {
  const body = buildPaymentRequired({ resource: { url: "http://api.local/meter" }, accepts });
  return new Response("{}", { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body) } });
}

function paid200(actual: string): Response {
  const receipt = encodeSettleResponse({ success: true, transaction: `0x${"11".repeat(32)}`, network: "eip155:84532", amount: actual });
  return new Response("metered", { status: 200, headers: { [HEADER_PAYMENT_RESPONSE]: receipt } });
}

describe("wrapFetch × upto", () => {
  it("signs the cap with the upto proxy as spender and the facilitator in the witness", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(req402([capTerms("10000")])).mockResolvedValueOnce(paid200("4000"));
    const onPaid = vi.fn();
    const pay = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, assets: [ASSET], maxAmount: "10000", onPaid });
    const res = await pay("http://api.local/meter");
    expect(res.status).toBe(200);

    const retry = fetchImpl.mock.calls[1]![0] as Request;
    const payload = decodePaymentPayload<UptoPayload>(retry.headers.get(HEADER_PAYMENT_SIGNATURE)!);
    expect(payload.payload.permit2Authorization.permitted.amount).toBe("10000");
    expect(payload.payload.permit2Authorization.spender).toBe(X402_UPTO_PERMIT2_PROXY_ADDRESS);
    expect(payload.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR);
    expect(onPaid).toHaveBeenCalledWith(capTerms("10000"), expect.objectContaining({ amount: "4000" }));
  });

  it("maxAmount bounds the CAP — a cap above it is never signed", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(req402([capTerms("10001")]));
    const onSkipped = vi.fn();
    const pay = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, assets: [ASSET], maxAmount: "10000", onSkipped });
    expect((await pay("http://api.local/meter")).status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("exceeds maxAmount"), expect.anything());
  });

  it("never refunds the budget on the seller-reported charge — PAYMENT-RESPONSE is untrusted", async () => {
    // budget 10000: reserve the 10000 cap; a seller claiming it charged 0 must
    // not restore the budget, otherwise a hostile seller voids maxTotalAmount
    const onPaid = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(req402([capTerms("10000")]))
      .mockResolvedValueOnce(paid200("0"))
      .mockResolvedValueOnce(req402([capTerms("1")]));
    const onSkipped = vi.fn();
    const pay = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      assets: [ASSET],
      maxAmount: "10000",
      maxTotalAmount: "10000",
      onSkipped,
      onPaid,
    });
    expect((await pay("http://api.local/meter")).status).toBe(200);
    expect(onPaid).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: "0" })); // still observable
    expect((await pay("http://api.local/meter")).status).toBe(402);
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("maxTotalAmount"), expect.anything());
  });

  it("without a receipt the reservation likewise stays at the cap", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(req402([capTerms("10000")]))
      .mockResolvedValueOnce(new Response("metered", { status: 200 })) // no PAYMENT-RESPONSE
      .mockResolvedValueOnce(req402([capTerms("1")]));
    const onSkipped = vi.fn();
    const pay = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      assets: [ASSET],
      maxAmount: "10000",
      maxTotalAmount: "10000",
      onSkipped,
    });
    await pay("http://api.local/meter");
    expect((await pay("http://api.local/meter")).status).toBe(402);
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("maxTotalAmount"), expect.anything());
  });

  it("skips upto terms lacking a facilitator address, with the scheme's reason — never throws", async () => {
    const broken = { ...capTerms("10000"), extra: { assetTransferMethod: "permit2" as const } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(req402([broken]));
    const onSkipped = vi.fn();
    const pay = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, assets: [ASSET], maxAmount: "10000", onSkipped });
    expect((await pay("http://api.local/meter")).status).toBe(402);
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("facilitatorAddress"), [broken]);
  });
});
