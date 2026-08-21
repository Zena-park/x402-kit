import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentPayload,
  decodePaymentRequired,
  encodePaymentPayload,
  encodePaymentRequired,
} from "../src/index.js";
import { specPaymentPayload, specPaymentRequired } from "./fixtures.js";

describe("wire codec — transports-v2/http.md", () => {
  it("header names match the transport spec", () => {
    expect(HEADER_PAYMENT_REQUIRED).toBe("PAYMENT-REQUIRED");
    expect(HEADER_PAYMENT_SIGNATURE).toBe("PAYMENT-SIGNATURE");
    expect(HEADER_PAYMENT_RESPONSE).toBe("PAYMENT-RESPONSE");
  });

  it("the spec §5.1 example survives an encoding round trip", () => {
    const encoded = encodePaymentRequired(specPaymentRequired);
    expect(decodePaymentRequired(encoded)).toEqual(specPaymentRequired);
    // base64 is pure ASCII — it must be safe to put in a header
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("the spec §5.2 example survives an encoding round trip", () => {
    const encoded = encodePaymentPayload(specPaymentPayload);
    expect(decodePaymentPayload(encoded)).toEqual(specPaymentPayload);
  });
});
