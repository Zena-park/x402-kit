import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  MCP_META_PAYMENT,
  MCP_META_PAYMENT_RESPONSE,
  buildMcpPaymentRequired,
  buildPaymentRequired,
  type McpToolResult,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "@x402.kit/core";
import { wrapMcpClient, type McpCallToolParams } from "../src/mcp.js";

const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const resource = { url: "mcp://tool/financial_analysis" };

const paymentRequired = (accepts: PaymentRequirements[] = [terms]): McpToolResult =>
  buildMcpPaymentRequired(buildPaymentRequired({ resource, accepts, error: "Payment required" }));

const plainResult: McpToolResult = { content: [{ type: "text", text: "analysis…" }] };

function fakeClient(...results: Array<McpToolResult | Error>) {
  let i = 0;
  const callTool = vi.fn(async (_params: McpCallToolParams) => {
    const r = results[Math.min(i++, results.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  });
  return { callTool, listTools: vi.fn(async () => ({ tools: [] })) };
}

const call = { name: "financial_analysis", arguments: { ticker: "AAPL" } };

describe("wrapMcpClient", () => {
  it("passes ordinary results and errors through without signing", async () => {
    const client = fakeClient(plainResult);
    const paid = wrapMcpClient(client, { signer, maxAmount: "1000000", allowAnyAsset: true });
    expect(await paid.callTool(call)).toBe(plainResult);
    expect(client.callTool).toHaveBeenCalledTimes(1);

    const erroring = fakeClient({ isError: true, content: [{ type: "text", text: "boom" }] });
    const paid2 = wrapMcpClient(erroring, { signer, maxAmount: "1000000", allowAnyAsset: true });
    await paid2.callTool(call);
    expect(erroring.callTool).toHaveBeenCalledTimes(1);
  });

  it("pays a payment-required result and retries once with the payment in _meta as plain JSON", async () => {
    const receipt: SettleResponse = { success: true, transaction: `0x${"22".repeat(32)}`, network: terms.network };
    const paidResult: McpToolResult = { ...plainResult, _meta: { [MCP_META_PAYMENT_RESPONSE]: receipt } };
    const client = fakeClient(paymentRequired(), paidResult);
    const onPaid = vi.fn();
    const paid = wrapMcpClient(client, { signer, maxAmount: "1000000", assets: [`${terms.network}/${terms.asset}`], onPaid });

    const result = await paid.callTool(call);

    expect(result).toBe(paidResult);
    expect(client.callTool).toHaveBeenCalledTimes(2);
    const retryParams = client.callTool.mock.calls[1]![0];
    expect(retryParams.name).toBe(call.name);
    expect(retryParams.arguments).toEqual(call.arguments);
    const sent = retryParams._meta?.[MCP_META_PAYMENT] as PaymentPayload;
    expect(sent.x402Version).toBe(2);
    expect(sent.accepted).toEqual(terms);
    expect(sent.resource).toEqual(resource); // pinned for the seller's bindResource
    expect((sent.payload as { signature?: string }).signature).toMatch(/^0x/);
    expect(onPaid).toHaveBeenCalledWith(terms, receipt);
  });

  it("refuses terms above maxAmount and hands back the seller's result untouched", async () => {
    const first = paymentRequired();
    const client = fakeClient(first);
    const onSkipped = vi.fn();
    const paid = wrapMcpClient(client, { signer, maxAmount: "9999", allowAnyAsset: true, onSkipped });

    expect(await paid.callTool(call)).toBe(first);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalled();
  });

  it("never signs terms claiming to be payment-required but failing the schema", async () => {
    const bad: McpToolResult = {
      isError: true,
      structuredContent: { x402Version: 2, accepts: [{ scheme: "exact" }], resource },
    };
    const client = fakeClient(bad);
    const onSkipped = vi.fn();
    const paid = wrapMcpClient(client, { signer, maxAmount: "1000000", allowAnyAsset: true, onSkipped });

    expect(await paid.callTool(call)).toBe(bad);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(onSkipped.mock.calls[0]![0]).toMatch(/malformed payment terms/);
  });

  it("refunds the budget when the paid retry never reaches the seller", async () => {
    const client = fakeClient(paymentRequired(), new Error("socket closed"), paymentRequired(), plainResult);
    const paid = wrapMcpClient(client, {
      signer,
      maxAmount: "10000",
      maxTotalAmount: "10000", // fits exactly one payment — only refund makes the second attempt possible
      allowAnyAsset: true,
    });

    await expect(paid.callTool(call)).rejects.toThrow("socket closed");
    expect(await paid.callTool(call)).toBe(plainResult);
  });

  it("keeps the budget charged when the seller answers the paid retry with another payment-required", async () => {
    const client = fakeClient(paymentRequired(), paymentRequired(), paymentRequired());
    const onPaid = vi.fn();
    const onSkipped = vi.fn();
    const paid = wrapMcpClient(client, {
      signer,
      maxAmount: "10000",
      maxTotalAmount: "10000",
      allowAnyAsset: true,
      onPaid,
      onSkipped,
    });

    await paid.callTool(call); // seller refuses the payment — it holds the signature
    expect(onPaid).not.toHaveBeenCalled();

    await paid.callTool(call); // budget is spent: policy refuses before signing
    expect(onSkipped.mock.calls.at(-1)![0]).toMatch(/maxTotalAmount/);
  });

  it("passes every other client method through", async () => {
    const client = fakeClient(plainResult);
    const paid = wrapMcpClient(client, { signer, maxAmount: "1", allowAnyAsset: true });
    expect(await paid.listTools()).toEqual({ tools: [] });
  });
});
