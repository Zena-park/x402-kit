/**
 * Recipe: a paid MCP tool — an AI agent pays per tool call over the Model
 * Context Protocol (transports-v2/mcp.md). Same x402 payment as HTTP, carried
 * in MCP messages instead of headers.
 *
 * SELLER — `paidTool` wraps one `registerTool` tuple with the paywall. A call
 * without payment gets an `isError` result carrying the terms; a paid call
 * runs the handler and attaches the receipt in `_meta["x402/payment-response"]`.
 *
 * BUYER (agent) — `wrapMcpClient` gives an MCP client the same spending caps
 * as `wrapFetch`: catch the payment-required result, sign under
 * `maxAmount`/`maxTotalAmount`/`assets`, retry once with the payment in
 * `_meta["x402/payment"]`.
 *
 * Run: examples/run.sh paid-mcp-tool (boots the local world, then runs this).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { extractMcpSettleResponse } from "@x402.kit/core";
import { wrapMcpClient } from "@x402.kit/buyer/mcp";
import { paidTool } from "@x402.kit/seller/mcp";
import { FACILITATOR, NETWORK, SELLER, TOKEN, balanceOf, buyer, chainNow, fmt } from "./lib.js";

async function main(): Promise<void> {
  // ── SELLER: an MCP server whose tool charges 500 KRW per call ──────────
  const server = new McpServer({ name: "paid-tools-demo", version: "1.0.0" });
  server.registerTool(
    ...paidTool(
      "market_report",
      {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "500000000", // 500 KRW per call
            asset: TOKEN,
            payTo: SELLER,
            maxTimeoutSeconds: 60,
            extra: { name: "Test KRW Stablecoin", version: "1" },
          },
        ],
        facilitator: FACILITATOR,
      },
      { description: "A paid market report", inputSchema: { ticker: z.string() } },
      async ({ ticker }) => ({
        content: [{ type: "text" as const, text: `${ticker}: buy low, sell high.` }],
      }),
    ),
  );

  // ── BUYER (agent): the same caps vocabulary as wrapFetch ───────────────
  const client = new Client({ name: "agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const paid = wrapMcpClient(client, {
    signer: buyer,
    maxAmount: "500000000", // never sign above 500 KRW per call
    maxTotalAmount: "2000000000", // whole-session budget: 2,000 KRW
    assets: [TOKEN],
    clock: chainNow, // demo only: sign against anvil's clock
  });

  const before = await balanceOf(buyer.address);
  const result = await paid.callTool({ name: "market_report", arguments: { ticker: "TKRW" } });
  const { content } = result as { content: Array<{ text: string }> };
  console.log(`tool answered: "${content[0]!.text}"`);

  const receipt = extractMcpSettleResponse(result);
  console.log(`receipt: success=${receipt?.success} tx=${receipt?.transaction}`);
  console.log(`buyer balance: ${fmt(before)} → ${fmt(await balanceOf(buyer.address))}`);

  await client.close();
  await server.close();
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
