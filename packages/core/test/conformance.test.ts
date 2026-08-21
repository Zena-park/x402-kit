/**
 * Conformance against the official Coinbase `@x402/core` schemas.
 *
 * This is the test that turns the kit's central claim — "spec-exact, standard
 * x402 clients connect by changing only the URL" — from a comment into CI. If
 * an upstream field is renamed or reshaped, these fail the day it publishes.
 *
 * Every object this kit PRODUCES must parse against the official V2 schemas,
 * and an official-shaped object must survive this kit's decode + verify
 * envelope. Both exact transfer methods (eip3009 and permit2) are exercised.
 */

import { describe, expect, it } from "vitest";
import {
  PaymentPayloadV2Schema,
  PaymentRequiredV2Schema,
  PaymentRequirementsV2Schema,
  parsePaymentPayload as officialParsePaymentPayload,
  parsePaymentRequired as officialParsePaymentRequired,
} from "@x402/core/schemas";
import {
  buildPaymentRequired,
  decodePaymentPayload,
  encodePaymentPayload,
  exactScheme,
  selectRequirements,
  type PaymentRequirements,
} from "../src/index.js";
import { specRequirements, testAccount } from "./fixtures.js";

const NOW = 1_767_225_600;

describe("conformance — kit output parses against official @x402/core V2 schemas", () => {
  it("buildPaymentRequired output conforms", () => {
    const required = buildPaymentRequired({
      resource: { url: "https://api.example.com/premium" },
      accepts: [specRequirements],
    });
    expect(PaymentRequiredV2Schema.safeParse(required).success).toBe(true);
    expect(officialParsePaymentRequired(required).success).toBe(true);
  });

  it("a specRequirements entry conforms to the official PaymentRequirements", () => {
    expect(PaymentRequirementsV2Schema.safeParse(specRequirements).success).toBe(true);
  });

  it("exactScheme.buildPayload output conforms", async () => {
    const payload = await exactScheme.buildPayload(specRequirements, { signer: testAccount, now: NOW });
    expect(PaymentPayloadV2Schema.safeParse(payload).success).toBe(true);
    expect(officialParsePaymentPayload(payload).success).toBe(true);
  });

  it("exact/permit2 buildPayload output and requirements conform", async () => {
    const permit2Terms: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "permit2" },
    };
    expect(PaymentRequirementsV2Schema.safeParse(permit2Terms).success).toBe(true);
    const payload = await exactScheme.buildPayload(permit2Terms, { signer: testAccount, now: NOW });
    expect(PaymentPayloadV2Schema.safeParse(payload).success).toBe(true);
    expect(officialParsePaymentPayload(payload).success).toBe(true);
  });
});

describe("conformance — an official-shaped object survives this kit's pipeline", () => {
  // Hand-written to match the official x402 docs' example exactly.
  const officialPayload = {
    x402Version: 2 as const,
    resource: { url: "https://api.example.com/premium-data" },
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        value: "10000",
        validAfter: "1740672089",
        validBefore: "1740672154",
        nonce: `0x${"f3".repeat(16)}`,
      },
    },
  };

  it("round-trips through the kit codec and the official parser agrees", () => {
    const encoded = encodePaymentPayload(officialPayload);
    const decoded = decodePaymentPayload(encoded);
    expect(decoded).toEqual(officialPayload);
    expect(officialParsePaymentPayload(decoded).success).toBe(true);
  });

  it("selectRequirements matches the echoed terms", () => {
    const accepts = [officialPayload.accepted as PaymentRequirements];
    const chosen = selectRequirements(accepts, officialPayload);
    expect(chosen).toEqual(officialPayload.accepted);
  });
});
