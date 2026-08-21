import { describe, expect, it, vi } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequired,
  decodeSettleResponse,
  encodePaymentPayload,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { createPaywall, withGate } from "../src/index.js";

function mockNodeReq() {
  return { method: "GET", url: "/premium", headers: { [HEADER_PAYMENT_SIGNATURE.toLowerCase()]: encodePaymentPayload(payload) } };
}
function mockNodeRes() {
  return { statusCode: 200, setHeader: () => {}, end: () => {} };
}

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: terms,
  payload: { signature: "0xabc", authorization: {} },
};

const okVerify: VerifyResponse = { isValid: true, payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66" };
const okSettle: SettleResponse = {
  success: true,
  transaction: `0x${"11".repeat(32)}`,
  network: terms.network,
};

function fakeFacilitator(verify: VerifyResponse, settle: SettleResponse) {
  return {
    verify: vi.fn(async (_req: FacilitatorRequest) => verify),
    settle: vi.fn(async (_req: FacilitatorRequest) => settle),
  };
}

const paidRequest = () =>
  new Request("http://shop.local/premium", {
    headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) },
  });

describe("createPaywall", () => {
  it("rejects construction when exact terms lack the EIP-712 domain", () => {
    const broken = { ...terms, extra: undefined };
    expect(() => createPaywall({ accepts: [broken], facilitator: "http://f" })).toThrow(/EIP-712/);
  });

  it("no payment header -> 402 whose header decodes to the terms", async () => {
    const pw = createPaywall({ accepts: [terms], facilitator: fakeFacilitator(okVerify, okSettle) });
    const decision = await pw.check(new Request("http://shop.local/premium"));

    expect(decision.paid).toBe(false);
    if (decision.paid) return;
    expect(decision.response.status).toBe(402);
    const header = decision.response.headers.get(HEADER_PAYMENT_REQUIRED)!;
    const required = decodePaymentRequired(header);
    expect(required.accepts).toEqual([terms]);
    expect(required.resource.url).toBe("http://shop.local/premium");
  });

  it("verify rejection -> 402 carrying the reason", async () => {
    const facilitator = fakeFacilitator({ isValid: false, invalidReason: "insufficient_funds" }, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator });
    const decision = await pw.check(paidRequest());

    expect(decision.paid).toBe(false);
    if (decision.paid) return;
    const required = decodePaymentRequired(decision.response.headers.get(HEADER_PAYMENT_REQUIRED)!);
    expect(required.error).toBe("insufficient_funds");
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("verified + settled -> paid, PAYMENT-RESPONSE decodes to the settlement", async () => {
    const facilitator = fakeFacilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator });
    const decision = await pw.check(paidRequest());

    expect(decision.paid).toBe(true);
    if (!decision.paid) return;
    expect(decodeSettleResponse(decision.responseHeaders[HEADER_PAYMENT_RESPONSE]!)).toEqual(okSettle);
  });

  it("settlement failure -> 402 (sync mode blocks the resource)", async () => {
    const facilitator = fakeFacilitator(okVerify, {
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: "",
      network: terms.network,
    });
    const pw = createPaywall({ accepts: [terms], facilitator });
    const decision = await pw.check(paidRequest());
    expect(decision.paid).toBe(false);
  });

  it("async mode -> paid on verify, settlement reported via onSettled", async () => {
    const facilitator = fakeFacilitator(okVerify, okSettle);
    const onSettled = vi.fn();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "async", onSettled });

    const decision = await pw.check(paidRequest());
    expect(decision.paid).toBe(true);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(okSettle, payload));
  });

  it("after-handler mode -> verify only in check(), settle deferred to capture()", async () => {
    const facilitator = fakeFacilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler" });

    const decision = await pw.check(paidRequest());
    expect(decision.paid).toBe(true);
    if (!decision.paid) return;
    expect(facilitator.settle).not.toHaveBeenCalled(); // not settled yet
    expect(typeof decision.capture).toBe("function");

    // The adapter calls capture() after a successful handler.
    const { header, settlement } = await decision.capture!();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(settlement).toEqual(okSettle);
    expect(header).toBeTruthy();

    // capture is idempotent — a second call does not re-settle.
    await decision.capture!();
    expect(facilitator.settle).toHaveBeenCalledOnce();
  });

  it("after-handler mode -> a handler that throws never settles (node withGate)", async () => {
    const facilitator = fakeFacilitator(okVerify, okSettle);
    const gate = createPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const failing = withGate(gate, async () => {
      throw new Error("handler blew up");
    });

    const res = mockNodeRes();
    await expect(failing(mockNodeReq(), res)).rejects.toThrow(/blew up/);
    expect(facilitator.settle).not.toHaveBeenCalled(); // buyer never charged
  });
});
