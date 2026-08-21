/**
 * Input-bounds regression — malformed untrusted input must be rejected
 * cleanly, never crash a handler with a thrown BigInt/TypeError. Each case
 * here was a real 500 (or worse) before validation was added.
 */

import { describe, expect, it } from "vitest";
import {
  decodePaymentPayloadSafe,
  encodePaymentPayload,
  matchesRequirements,
  parseFacilitatorRequest,
  type PaymentRequirements,
} from "../src/index.js";

const base: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
};

describe("schema validation rejects crash-inducing input (never throws)", () => {
  const badAmounts = ["abc", "0x10", "-1", "1.5", "1e6", "", " ", "١٢٣"];
  for (const amount of badAmounts) {
    it(`rejects amount ${JSON.stringify(amount)}`, () => {
      const req = {
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: { ...base, amount }, payload: {} },
        paymentRequirements: { ...base, amount },
      };
      expect(parseFacilitatorRequest(req).ok).toBe(false);
    });
  }

  it("rejects non-address asset/payTo, non-CAIP network, bad maxTimeoutSeconds", () => {
    const bads = [
      { ...base, asset: "notanaddress" },
      { ...base, payTo: "0x123" },
      { ...base, network: "mainnet" },
      { ...base, maxTimeoutSeconds: -1 },
      { ...base, maxTimeoutSeconds: 1.5 },
      { ...base, maxTimeoutSeconds: Number.NaN },
    ];
    for (const reqs of bads) {
      const req = {
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: reqs, payload: {} },
        paymentRequirements: reqs,
      };
      expect(parseFacilitatorRequest(req).ok).toBe(false);
    }
  });

  it("matchesRequirements never throws on a malformed wire amount", () => {
    expect(() => matchesRequirements({ ...base, amount: "abc" }, base)).not.toThrow();
    expect(matchesRequirements({ ...base, amount: "abc" }, base)).toBe(false);
    expect(matchesRequirements({ ...base, amount: "0x10" }, { ...base, amount: "16" })).toBe(false);
  });

  it("decodePaymentPayloadSafe returns an error result, not a throw, on garbage", () => {
    expect(decodePaymentPayloadSafe("not!base64!").ok).toBe(false);
    expect(decodePaymentPayloadSafe(Buffer.from("{}", "utf8").toString("base64")).ok).toBe(false);
    const bad = { x402Version: 2, accepted: { ...base, amount: "abc" }, payload: {} };
    expect(decodePaymentPayloadSafe(encodePaymentPayload(bad as never)).ok).toBe(false);
  });

  it("accepts a well-formed request", () => {
    const good = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: base, payload: { signature: "0x", authorization: {} } },
      paymentRequirements: base,
    };
    expect(parseFacilitatorRequest(good).ok).toBe(true);
  });
});
