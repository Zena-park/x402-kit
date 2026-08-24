/**
 * MCP transport e2e — the kit's paid-tool surface over the REAL MCP SDK
 * (@modelcontextprotocol/sdk, InMemoryTransport):
 *
 *   @x402.kit/buyer/mcp (wrapMcpClient) ↔ @x402.kit/seller/mcp (paidTool)
 *                                       ↔ @x402.kit/facilitator (HTTP)
 *
 * Proves, on-chain:
 *   1. exact/EIP-3009 over MCP — terms as an isError result, payment in
 *      _meta["x402/payment"], receipt in _meta["x402/payment-response"]
 *   2. upto over MCP — sign a cap, the handler meters, settlement-overrides
 *      settles the actual (after-handler mode); only the actual moves
 *   3. budget — a call that would exceed maxTotalAmount is refused before
 *      signing; the seller's payment-required result is handed back untouched
 */

import assert from "node:assert/strict";
import { createWalletClient, http, type Address } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_META_PAYMENT_RESPONSE,
  extractMcpPaymentRequired,
  extractMcpSettleResponse,
  type SupportedResponse,
} from "@x402.kit/core";
import { approvePermit2 } from "@x402.kit/buyer";
import { wrapMcpClient } from "@x402.kit/buyer/mcp";
import { uptoTerms } from "@x402.kit/seller";
import { MCP_META_SETTLEMENT_OVERRIDES, paidTool } from "@x402.kit/seller/mcp";
import {
  FACILITATOR_URL,
  RPC,
  SELLER,
  TOKEN,
  balanceOf,
  buyer,
  chainClock,
  krw,
  publicClient,
  wonTerms,
} from "./fixtures.js";

async function main(): Promise<void> {
  // ---- seller: one MCP server, one fixed-price tool, one metered tool ----
  const server = new McpServer({ name: "e2e-paid-tools", version: "0.0.0" });

  const exactTerms = wonTerms("1200000000"); // 1,200 KRW per call
  server.registerTool(
    ...paidTool(
      "premium_answer",
      { accepts: [exactTerms], facilitator: FACILITATOR_URL },
      { description: "a paid answer" },
      async () => ({ content: [{ type: "text" as const, text: "42" }] }),
    ),
  );

  const supported = (await (await fetch(`${FACILITATOR_URL}/supported`)).json()) as SupportedResponse;
  const facilitatorAddress = supported.kinds.find((k) => k.scheme === "upto" && k.network === "eip155:31337")
    ?.extra?.["facilitatorAddress"] as Address;
  assert.ok(facilitatorAddress, "facilitator should advertise upto");
  const capTerms = uptoTerms({
    network: "eip155:31337",
    asset: TOKEN,
    payTo: SELLER,
    maxAmount: "5000000000", // cap: 5,000 KRW
    facilitatorAddress,
  });
  server.registerTool(
    ...paidTool(
      "metered_answer",
      { accepts: [capTerms], facilitator: FACILITATOR_URL, settle: "after-handler" },
      { description: "usage-metered answer" },
      async () => ({
        content: [{ type: "text" as const, text: "tokens: 321" }],
        _meta: { [MCP_META_SETTLEMENT_OVERRIDES]: { amount: "321000000" } }, // actual: 321 KRW
      }),
    ),
  );

  // ---- transport: the real SDK, linked in memory ----
  const client = new Client({ name: "e2e-buyer", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // ---- buyer: same caps vocabulary as wrapFetch ----
  const walletClient = createWalletClient({ account: buyer, transport: http(RPC) });
  await approvePermit2({ walletClient, publicClient, token: TOKEN }); // upto is Permit2-only
  const skips: string[] = [];
  const paid = wrapMcpClient(client, {
    signer: buyer,
    maxAmount: "5000000000",
    maxTotalAmount: "6500000000", // one exact (1,200) + one cap (5,000); a second exact must not fit
    assets: [TOKEN],
    clock: chainClock,
    onSkipped: (reason) => skips.push(reason),
  });

  // 1. exact over MCP
  const before = await balanceOf(buyer.address);
  const one = (await paid.callTool({ name: "premium_answer", arguments: {} })) as Record<string, unknown>;
  assert.equal((one.content as Array<{ text: string }>)[0]!.text, "42");
  const receipt = extractMcpSettleResponse(one);
  assert.ok(receipt?.success, "receipt should ride _meta['x402/payment-response']");
  assert.equal(before - (await balanceOf(buyer.address)), 1_200_000_000n);
  console.log("[ok] exact over MCP — paid 1,200 KRW, receipt tx", receipt.transaction.slice(0, 18) + "…");

  // 2. upto over MCP — the cap is signed, only the actual moves
  const two = (await paid.callTool({ name: "metered_answer", arguments: {} })) as Record<string, unknown>;
  assert.equal((two.content as Array<{ text: string }>)[0]!.text, "tokens: 321");
  const meteredReceipt = extractMcpSettleResponse(two);
  assert.ok(meteredReceipt?.success);
  assert.equal(meteredReceipt.amount, "321000000", "the actual, not the cap, settles");
  assert.equal(before - (await balanceOf(buyer.address)), 1_200_000_000n + 321_000_000n);
  assert.equal(
    ((two as { _meta?: Record<string, unknown> })._meta ?? {})[MCP_META_SETTLEMENT_OVERRIDES],
    undefined,
    "the override never reaches the client",
  );
  console.log("[ok] upto over MCP — signed a 5,000 KRW cap, settled", krw(321_000_000n));

  // 3. budget: 1,200 + 5,000 (the signed cap, not the 321 actual) are charged —
  //    another 1,200 would exceed 6,500, so the wrapper refuses to sign
  const three = (await paid.callTool({ name: "premium_answer", arguments: {} })) as Record<string, unknown>;
  const stillRequired = extractMcpPaymentRequired(three);
  assert.ok(stillRequired?.ok, "the seller's payment-required result comes back untouched");
  assert.match(skips.at(-1) ?? "", /maxTotalAmount/);
  assert.equal(before - (await balanceOf(buyer.address)), 1_200_000_000n + 321_000_000n, "nothing moved");
  console.log("[ok] budget — third call refused before signing:", skips.at(-1));

  await client.close();
  await server.close();
  console.log("\nmcp e2e: all scenarios passed");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
