/**
 * Framework adapter tests — next (App Router) and fastify. They must gate the
 * handler on payment and attach PAYMENT-RESPONSE on success, without depending
 * on next or fastify (both are typed structurally).
 */

import { describe, expect, it, vi } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  encodePaymentPayload,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@x402kit/core";
import { withPaywall } from "../src/next.js";
import { paywall as fastifyPaywall } from "../src/fastify.js";
import { paywall as expressPaywall } from "../src/express.js";

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

const okSettle: SettleResponse = { success: true, transaction: `0x${"11".repeat(32)}`, network: terms.network };

function fakeFacilitator(verify: VerifyResponse, settle: SettleResponse) {
  return {
    verify: vi.fn(async (_r: FacilitatorRequest) => verify),
    settle: vi.fn(async (_r: FacilitatorRequest) => settle),
  };
}

describe("next adapter (withPaywall)", () => {
  it("no payment → 402, handler never runs", async () => {
    const handler = vi.fn(async () => Response.json({ data: "premium" }));
    const route = withPaywall({ accepts: [terms], facilitator: fakeFacilitator({ isValid: true }, okSettle) }, handler);

    const res = await route(new Request("http://shop.local/premium"), {});
    expect(res.status).toBe(402);
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });

  it("valid payment → handler runs, PAYMENT-RESPONSE attached", async () => {
    const handler = vi.fn(async () => Response.json({ data: "premium" }));
    const route = withPaywall(
      { accepts: [terms], facilitator: fakeFacilitator({ isValid: true, payer: terms.payTo }, okSettle) },
      handler,
    );

    const req = new Request("http://shop.local/premium", {
      headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) },
    });
    const res = await route(req, {});
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(res.headers.get(HEADER_PAYMENT_RESPONSE)).toBeTruthy();
  });
});

describe("fastify adapter (preHandler)", () => {
  // Minimal fastify reply.raw stand-in (NodeResponseLike)
  function mockReply() {
    const headers: Record<string, string> = {};
    const raw = {
      statusCode: 200,
      setHeader: (n: string, v: string) => void (headers[n.toLowerCase()] = v),
      end: vi.fn(),
    };
    return {
      raw,
      headers,
      fastHeaders: {} as Record<string, string>,
      header: vi.fn(function (this: unknown, n: string, v: string) {
        return v;
      }),
      hijack: vi.fn(),
    };
  }

  function mockRequest(withPayment: boolean) {
    return { raw: { method: "GET", url: "/premium", headers: withPayment ? { [HEADER_PAYMENT_SIGNATURE.toLowerCase()]: encodePaymentPayload(payload) } : {} } };
  }

  it("no payment → hijacks and writes 402", async () => {
    const hook = fastifyPaywall({ accepts: [terms], facilitator: fakeFacilitator({ isValid: true }, okSettle) });
    const reply = mockReply();
    await hook(mockRequest(false), reply as never);

    expect(reply.hijack).toHaveBeenCalledOnce();
    expect(reply.raw.statusCode).toBe(402);
    expect(reply.raw.end).toHaveBeenCalledOnce();
    expect(reply.headers[HEADER_PAYMENT_REQUIRED.toLowerCase()]).toBeTruthy();
  });

  it("valid payment → sets PAYMENT-RESPONSE, does not hijack", async () => {
    const hook = fastifyPaywall({
      accepts: [terms],
      facilitator: fakeFacilitator({ isValid: true, payer: terms.payTo }, okSettle),
    });
    const reply = mockReply();
    await hook(mockRequest(true), reply as never);

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith(HEADER_PAYMENT_RESPONSE, expect.any(String));
  });

  it("after-handler mode → the hook settles (never silently skipped)", async () => {
    const facilitator = fakeFacilitator({ isValid: true, payer: terms.payTo }, okSettle);
    const hook = fastifyPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const reply = mockReply();
    await hook(mockRequest(true), reply as never);

    expect(facilitator.settle).toHaveBeenCalledOnce(); // NOT skipped
    expect(reply.header).toHaveBeenCalledWith(HEADER_PAYMENT_RESPONSE, expect.any(String));
  });
});

describe("express adapter — after-handler must not skip settlement", () => {
  function mockRes() {
    return { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  }
  function mockReq(withPayment: boolean) {
    return { method: "GET", url: "/premium", headers: withPayment ? { [HEADER_PAYMENT_SIGNATURE.toLowerCase()]: encodePaymentPayload(payload) } : {} };
  }

  it("settles before next() so the buyer is actually charged", async () => {
    const facilitator = fakeFacilitator({ isValid: true, payer: terms.payTo }, okSettle);
    const mw = expressPaywall({ accepts: [terms], facilitator, settle: "after-handler" });
    const res = mockRes();
    const next = vi.fn();

    await new Promise<void>((resolve) => {
      const doneNext = (...a: unknown[]) => {
        next(...a);
        resolve();
      };
      mw(mockReq(true), res as never, doneNext as never);
    });

    expect(facilitator.settle).toHaveBeenCalledOnce(); // the bug was: never called
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_PAYMENT_RESPONSE, expect.any(String));
  });
});
