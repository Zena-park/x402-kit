/**
 * Seller side of upto: uptoTerms, capture({ amount }) rewriting the settle
 * request's amount (and only that), the local over-cap refusal, and the
 * Settlement-Overrides header channel in the wrapper adapters.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ErrorReason,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  encodePaymentPayload,
  type FacilitatorRequest,
  type PaymentPayload,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { SETTLEMENT_OVERRIDES_HEADER, createPaywall, uptoTerms, withGate } from "../src/index.js";
import { withPaywall as nextPaywall } from "../src/next.js";
import { paywall as honoPaywall } from "../src/hono.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const FACILITATOR = "0x1111111111111111111111111111111111111111";

const terms = uptoTerms({ network: "eip155:84532", asset: ASSET, payTo: PAY_TO, maxAmount: "10000", facilitatorAddress: FACILITATOR });

/** Shape only — the fake facilitator does not verify signatures */
const payload: PaymentPayload = {
  x402Version: 2,
  accepted: terms,
  payload: {
    signature: "0xabc",
    permit2Authorization: { from: "0x857b06519E91e3A54538791bDbb0E22373e36b66", nonce: "7", witness: { facilitator: FACILITATOR } },
  },
};

const okVerify: VerifyResponse = { isValid: true, payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66" };
const settledWith = (amount: string): SettleResponse => ({ success: true, transaction: `0x${"11".repeat(32)}`, network: terms.network, amount });

function fakeFacilitator() {
  return {
    verify: vi.fn(async (_r: FacilitatorRequest) => okVerify),
    // echo back the requested amount, like a real upto settle does
    settle: vi.fn(async (r: FacilitatorRequest) => settledWith(r.paymentRequirements.amount)),
  };
}

const paidRequest = () => new Request("http://shop.local/meter", { headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) } });

describe("uptoTerms", () => {
  it("builds upto terms: amount = cap, permit2, facilitator bound", () => {
    expect(terms).toMatchObject({
      scheme: "upto",
      amount: "10000",
      extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR },
      maxTimeoutSeconds: 60,
    });
  });

  it("createPaywall rejects upto terms without a facilitator address at construction", () => {
    const broken = { ...terms, extra: { assetTransferMethod: "permit2" as const } };
    expect(() => createPaywall({ accepts: [broken], facilitator: "http://f" })).toThrow(/facilitatorAddress/);
  });
});

describe("capture({ amount })", () => {
  it("sends the ACTUAL amount in paymentRequirements, leaves the payload untouched", async () => {
    const facilitator = fakeFacilitator();
    const onSettled = vi.fn();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler", onSettled });
    const decision = await pw.check(paidRequest());
    expect(decision.paid).toBe(true);
    if (!decision.paid || !decision.capture) throw new Error("expected capture");

    const { header, settlement } = await decision.capture({ amount: "4000" });
    const sent = facilitator.settle.mock.calls[0]![0];
    expect(sent.paymentRequirements.amount).toBe("4000");
    expect(sent.paymentPayload).toEqual(payload); // the signed cap is intact
    expect(facilitator.verify.mock.calls[0]![0].paymentRequirements.amount).toBe("10000"); // verify saw the cap
    expect(settlement.amount).toBe("4000");
    expect(header).toBeTruthy();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ amount: "4000" }), payload);
  });

  it("no amount → the full signed figure", async () => {
    const facilitator = fakeFacilitator();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const decision = await pw.check(paidRequest());
    if (!decision.paid || !decision.capture) throw new Error("expected capture");
    await decision.capture();
    expect(facilitator.settle.mock.calls[0]![0].paymentRequirements.amount).toBe("10000");
  });

  it("over the cap → local failure via onSettled, no facilitator call, claim released", async () => {
    const facilitator = fakeFacilitator();
    const onSettled = vi.fn();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler", onSettled });
    const decision = await pw.check(paidRequest());
    if (!decision.paid || !decision.capture) throw new Error("expected capture");

    const { header, settlement } = await decision.capture({ amount: "10001" });
    expect(header).toBeUndefined();
    expect(settlement.success).toBe(false);
    expect(settlement.errorReason).toBe(ErrorReason.UPTO_SETTLEMENT_EXCEEDS_AMOUNT);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ success: false }), payload);
    // the replay claim was given back — the same header can be presented again
    const again = await pw.check(paidRequest());
    expect(again.paid).toBe(true);
  });

  it("the first call's amount wins — concurrent captures settle once", async () => {
    const facilitator = fakeFacilitator();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const decision = await pw.check(paidRequest());
    if (!decision.paid || !decision.capture) throw new Error("expected capture");
    const [a, b] = await Promise.all([decision.capture({ amount: "3000" }), decision.capture({ amount: "9000" })]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(a.settlement.amount).toBe("3000");
    expect(b.settlement.amount).toBe("3000");
  });
});

describe("Settlement-Overrides header → capture amount", () => {
  it("node withGate reads and strips the header the handler set", async () => {
    const facilitator = fakeFacilitator();
    const pw = createPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const headers = new Map<string, string>();
    const res = {
      statusCode: 200,
      setHeader: (n: string, v: string) => void headers.set(n.toLowerCase(), v),
      getHeader: (n: string) => headers.get(n.toLowerCase()),
      removeHeader: (n: string) => void headers.delete(n.toLowerCase()),
      end: () => {},
    };
    const handler = vi.fn(async (_req: unknown, r: typeof res) => {
      r.setHeader(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: "2500" }));
    });
    await withGate(pw, handler)(
      { method: "GET", url: "/meter", headers: { [HEADER_PAYMENT_SIGNATURE.toLowerCase()]: encodePaymentPayload(payload) } },
      res,
    );
    expect(handler).toHaveBeenCalled();
    expect(facilitator.settle.mock.calls[0]![0].paymentRequirements.amount).toBe("2500");
    expect(headers.has(SETTLEMENT_OVERRIDES_HEADER)).toBe(false); // never reaches the client
  });

  it("next withPaywall reads it off the handler's Response, strips it, attaches PAYMENT-RESPONSE", async () => {
    const facilitator = fakeFacilitator();
    const route = nextPaywall({ accepts: [terms], facilitator, settle: "after-handler" }, async () =>
      Response.json({ tokens: 321 }, { headers: { [SETTLEMENT_OVERRIDES_HEADER]: JSON.stringify({ amount: "321" }) } }),
    );
    const res = await route(paidRequest(), {});
    expect(res.status).toBe(200);
    expect(facilitator.settle.mock.calls[0]![0].paymentRequirements.amount).toBe("321");
    expect(res.headers.get(SETTLEMENT_OVERRIDES_HEADER)).toBeNull();
    expect(res.headers.get(HEADER_PAYMENT_RESPONSE)).toBeTruthy();
  });

  it("hono paywall reads it from c.res after next()", async () => {
    const facilitator = fakeFacilitator();
    const mw = honoPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const outgoing = new Headers();
    const c = {
      req: { raw: paidRequest() },
      header: (n: string, v: string) => outgoing.set(n, v),
      res: { headers: outgoing },
    };
    await mw(c, async () => {
      outgoing.set(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: "77" }));
    });
    expect(facilitator.settle.mock.calls[0]![0].paymentRequirements.amount).toBe("77");
    expect(outgoing.get(SETTLEMENT_OVERRIDES_HEADER)).toBeNull();
    expect(outgoing.get(HEADER_PAYMENT_RESPONSE)).toBeTruthy();
  });

  it("a malformed header settles the full amount rather than failing the request", async () => {
    const facilitator = fakeFacilitator();
    const route = nextPaywall({ accepts: [terms], facilitator, settle: "after-handler" }, async () =>
      Response.json({}, { headers: { [SETTLEMENT_OVERRIDES_HEADER]: "not json" } }),
    );
    await route(paidRequest(), {});
    expect(facilitator.settle.mock.calls[0]![0].paymentRequirements.amount).toBe("10000");
  });
});
