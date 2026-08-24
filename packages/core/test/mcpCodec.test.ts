import { describe, expect, it } from "vitest";
import {
  MCP_META_PAYMENT,
  MCP_META_PAYMENT_RESPONSE,
  attachMcpPayment,
  attachMcpSettleResponse,
  buildMcpPaymentRequired,
  extractMcpPayment,
  extractMcpPaymentRequired,
  extractMcpSettleResponse,
  mcpToolResourceUrl,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
} from "../src/index.js";

// Fixtures lifted from the spec's own examples (transports-v2/mcp.md)
const specPaymentRequired: PaymentRequired = {
  x402Version: 2,
  error: "Payment required to access this resource",
  resource: {
    url: "mcp://tool/financial_analysis",
    description: "Advanced financial analysis tool",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

const specPayment: PaymentPayload = {
  x402Version: 2,
  resource: specPaymentRequired.resource,
  accepted: specPaymentRequired.accepts[0],
  payload: {
    signature:
      "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  },
};

const specSettle: SettleResponse = {
  success: true,
  transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  network: "eip155:84532",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

describe("mcpToolResourceUrl", () => {
  it("matches the spec's mcp://tool/<name> form", () => {
    expect(mcpToolResourceUrl("financial_analysis")).toBe("mcp://tool/financial_analysis");
  });
});

describe("buildMcpPaymentRequired", () => {
  it("carries the PaymentRequired in both structuredContent and content[0].text (spec server requirement)", () => {
    const result = buildMcpPaymentRequired(specPaymentRequired);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(specPaymentRequired);
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]?.type).toBe("text");
    expect(JSON.parse(result.content![0]!.text!)).toEqual(specPaymentRequired);
  });
});

describe("extractMcpPaymentRequired", () => {
  it("prefers structuredContent", () => {
    const extracted = extractMcpPaymentRequired(buildMcpPaymentRequired(specPaymentRequired));
    expect(extracted).toEqual({ ok: true, value: specPaymentRequired });
  });

  it("falls back to parsing content[0].text (spec client requirement)", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(specPaymentRequired) }],
    };
    expect(extractMcpPaymentRequired(result)).toEqual({ ok: true, value: specPaymentRequired });
  });

  it("returns undefined for ordinary tool results and errors", () => {
    expect(extractMcpPaymentRequired({ content: [{ type: "text", text: "hi" }] })).toBeUndefined();
    expect(extractMcpPaymentRequired({ isError: true, content: [{ type: "text", text: "boom" }] })).toBeUndefined();
    expect(extractMcpPaymentRequired(undefined)).toBeUndefined();
    expect(extractMcpPaymentRequired("nope")).toBeUndefined();
  });

  it("returns ok:false for a result that claims to be a payment request but fails the schema", () => {
    const bad = {
      isError: true,
      structuredContent: { x402Version: 2, accepts: [{ scheme: "exact" }], resource: { url: "mcp://tool/x" } },
    };
    const extracted = extractMcpPaymentRequired(bad);
    expect(extracted).toBeDefined();
    expect(extracted!.ok).toBe(false);
  });
});

describe("payment _meta", () => {
  it("attach + extract round-trips the spec example payload as plain JSON", () => {
    const meta = attachMcpPayment({ other: 1 }, specPayment);
    expect(meta.other).toBe(1);
    expect(meta[MCP_META_PAYMENT]).toEqual(specPayment); // no base64 anywhere
    expect(extractMcpPayment(meta)).toEqual({ ok: true, value: specPayment });
  });

  it("absent payment → undefined; malformed → ok:false", () => {
    expect(extractMcpPayment(undefined)).toBeUndefined();
    expect(extractMcpPayment({})).toBeUndefined();
    const bad = extractMcpPayment({ [MCP_META_PAYMENT]: { x402Version: 2 } });
    expect(bad).toBeDefined();
    expect(bad!.ok).toBe(false);
  });
});

describe("settle receipt _meta", () => {
  it("attach + extract round-trips and preserves the result's other fields and meta", () => {
    const result = { content: [{ type: "text", text: "analysis…" }], _meta: { kept: true } };
    const attached = attachMcpSettleResponse(result, specSettle);
    expect(attached.content).toEqual(result.content);
    expect(attached._meta?.kept).toBe(true);
    expect(attached._meta?.[MCP_META_PAYMENT_RESPONSE]).toEqual(specSettle);
    expect(extractMcpSettleResponse(attached)).toEqual(specSettle);
  });

  it("a malformed receipt never throws — it reads as absent", () => {
    expect(extractMcpSettleResponse({ _meta: { [MCP_META_PAYMENT_RESPONSE]: "junk" } })).toBeUndefined();
    expect(extractMcpSettleResponse({ _meta: { [MCP_META_PAYMENT_RESPONSE]: { success: "yes" } } })).toBeUndefined();
    expect(extractMcpSettleResponse({})).toBeUndefined();
    expect(extractMcpSettleResponse(null)).toBeUndefined();
  });
});
