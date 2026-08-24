import { describe, expect, it, vi } from "vitest";
import {
  MCP_META_PAYMENT,
  MCP_META_PAYMENT_RESPONSE,
  extractMcpPaymentRequired,
  type FacilitatorRequest,
  type McpToolResult,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { FacilitatorUnreachableError } from "../src/client.js";
import { MCP_META_SETTLEMENT_OVERRIDES, paidTool } from "../src/mcp.js";

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const payment: PaymentPayload = {
  x402Version: 2,
  accepted: terms,
  payload: { signature: "0xabc", authorization: { nonce: "0x01" } },
};

const okVerify: VerifyResponse = { isValid: true, payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66" };
const okSettle: SettleResponse = { success: true, transaction: `0x${"11".repeat(32)}`, network: terms.network };

function fakeFacilitator(verify: VerifyResponse | Error = okVerify, settle: SettleResponse | Error = okSettle) {
  return {
    verify: vi.fn(async (_req: FacilitatorRequest) => {
      if (verify instanceof Error) throw verify;
      return verify;
    }),
    settle: vi.fn(async (_req: FacilitatorRequest) => {
      if (settle instanceof Error) throw settle;
      return settle;
    }),
  };
}

const toolResult: McpToolResult = { content: [{ type: "text", text: "42" }] };

function register(options: Partial<Parameters<typeof paidTool>[1]> = {}, handler = vi.fn(async () => toolResult)) {
  const facilitator = (options.facilitator as ReturnType<typeof fakeFacilitator>) ?? fakeFacilitator();
  const [name, config, wrapped] = paidTool(
    "financial_analysis",
    { accepts: [terms], ...options, facilitator },
    { description: "paid analysis" },
    handler,
  );
  return { name, config, wrapped, handler, facilitator };
}

const paidExtra = (p: PaymentPayload = payment) => ({ _meta: { [MCP_META_PAYMENT]: p } });

describe("paidTool", () => {
  it("returns the registerTool tuple with the name and config untouched", () => {
    const { name, config } = register();
    expect(name).toBe("financial_analysis");
    expect(config).toEqual({ description: "paid analysis" });
  });

  it("answers a call without payment with a spec-shaped payment-required result", async () => {
    const { wrapped, handler, facilitator } = register();
    const result = await wrapped({}, {});
    expect(handler).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
    const required = extractMcpPaymentRequired(result);
    expect(required?.ok).toBe(true);
    if (!required?.ok) return;
    expect(required.value.error).toBe("Payment required to access this resource");
    expect(required.value.resource.url).toBe("mcp://tool/financial_analysis");
    expect(required.value.accepts).toEqual([terms]);
    // both spec formats present and identical
    expect(JSON.parse((result as McpToolResult).content![0]!.text!)).toEqual(required.value);
  });

  it("refuses a malformed payment with invalid_payload, without calling the facilitator", async () => {
    const { wrapped, facilitator } = register();
    const result = await wrapped({}, { _meta: { [MCP_META_PAYMENT]: { x402Version: 2 } } });
    const required = extractMcpPaymentRequired(result);
    expect(required?.ok).toBe(true);
    if (!required?.ok) return;
    expect(required.value.error).toBe("invalid_payload");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("refuses an oversized payment before any schema or facilitator work", async () => {
    const { wrapped, facilitator } = register();
    const huge = { ...payment, payload: { blob: "x".repeat(9 * 1024) } };
    const result = await wrapped({}, paidExtra(huge as PaymentPayload));
    const required = extractMcpPaymentRequired(result);
    expect(required?.ok).toBe(true);
    if (!required?.ok) return;
    expect(required.value.error).toBe("invalid_payload");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("sync: verifies, settles, runs the handler, and attaches the receipt", async () => {
    const { wrapped, handler, facilitator } = register();
    const result = (await wrapped({ ticker: "AAPL" }, paidExtra())) as McpToolResult;
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual(toolResult.content);
    expect(result._meta?.[MCP_META_PAYMENT_RESPONSE]).toEqual(okSettle);
  });

  it("replays are refused: the same payment presented twice pays once", async () => {
    const { wrapped, handler } = register();
    await wrapped({}, paidExtra());
    const second = await wrapped({}, paidExtra());
    const required = extractMcpPaymentRequired(second);
    expect(required?.ok).toBe(true);
    if (!required?.ok) return;
    expect(required.value.error).toBe("authorization_already_used");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a facilitator outage becomes a non-payment-shaped error result (clients must not try to pay it)", async () => {
    const { wrapped } = register({ facilitator: fakeFacilitator(new FacilitatorUnreachableError("down")) });
    const result = (await wrapped({}, paidExtra())) as McpToolResult;
    expect(result.isError).toBe(true);
    expect(extractMcpPaymentRequired(result)).toBeUndefined();
    expect(JSON.parse(result.content![0]!.text!)).toEqual({ error: "facilitator_unavailable", retryAfter: 5 });
  });

  describe("after-handler", () => {
    it("settles after the handler succeeds and attaches the receipt", async () => {
      const { wrapped, facilitator } = register({ settle: "after-handler" });
      const result = (await wrapped({}, paidExtra())) as McpToolResult;
      expect(facilitator.settle).toHaveBeenCalledTimes(1);
      expect(result._meta?.[MCP_META_PAYMENT_RESPONSE]).toEqual(okSettle);
    });

    it("a throwing handler never charges the buyer", async () => {
      const handler = vi.fn(async () => {
        throw new Error("model exploded");
      });
      const { wrapped, facilitator } = register({ settle: "after-handler" }, handler as never);
      await expect(wrapped({}, paidExtra())).rejects.toThrow("model exploded");
      expect(facilitator.settle).not.toHaveBeenCalled();
    });

    it("a definite settlement failure withholds the content and returns only the payment error (spec)", async () => {
      const failed: SettleResponse = { success: false, errorReason: "insufficient_funds", transaction: "", network: terms.network };
      const handler = vi.fn(async () => ({ content: [{ type: "text", text: "SECRET-CONTENT" }] }));
      const { wrapped } = register({ settle: "after-handler", facilitator: fakeFacilitator(okVerify, failed) }, handler as never);
      const result = (await wrapped({}, paidExtra())) as McpToolResult;
      const required = extractMcpPaymentRequired(result);
      expect(required?.ok).toBe(true);
      if (!required?.ok) return;
      expect(required.value.error).toBe("Settlement failed");
      expect(JSON.stringify(result)).not.toContain("SECRET-CONTENT"); // the tool's content never leaves
    });

    it("a pending settlement delivers the content without a receipt", async () => {
      const pending: SettleResponse = { success: false, errorReason: "settlement_pending", transaction: "", network: terms.network };
      const { wrapped } = register({ settle: "after-handler", facilitator: fakeFacilitator(okVerify, pending) });
      const result = (await wrapped({}, paidExtra())) as McpToolResult;
      expect(result.content).toEqual(toolResult.content);
      expect(result._meta?.[MCP_META_PAYMENT_RESPONSE]).toBeUndefined();
    });

    it("strips the settlement-overrides meta from the delivered result", async () => {
      const handler = vi.fn(async () => ({
        content: [{ type: "text", text: "42" }],
        _meta: { keep: 1, [MCP_META_SETTLEMENT_OVERRIDES]: { amount: "321" } },
      }));
      const { wrapped } = register({ settle: "after-handler" }, handler as never);
      const result = (await wrapped({}, paidExtra())) as McpToolResult;
      expect(result._meta?.[MCP_META_SETTLEMENT_OVERRIDES]).toBeUndefined();
      expect(result._meta?.keep).toBe(1);
      expect(result._meta?.[MCP_META_PAYMENT_RESPONSE]).toEqual(okSettle);
    });
  });
});
