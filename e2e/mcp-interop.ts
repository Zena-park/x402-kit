/**
 * MCP conformance — interop with the OFFICIAL @x402/mcp SDK as the oracle
 * (the kit's rule: the reference implementation is never copied, only paid
 * against). Both legs settle on-chain through the KIT facilitator (spec §7):
 *
 *   Leg B: official buyer (createx402MCPClient + ExactEvmScheme)
 *          → kit seller (@x402.kit/seller/mcp paidTool)
 *   Leg C: kit buyer (@x402.kit/buyer/mcp wrapMcpClient)
 *          → official seller (createPaymentWrapper + x402ResourceServer)
 *
 * Passing means the kit's MCP wire (payment-required results, _meta payment,
 * _meta receipts) is byte-compatible with the official implementation in both
 * directions.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createPaymentWrapper,
  createx402MCPClient,
  x402ResourceServer,
  type PaymentRequirements as OfficialPaymentRequirements,
} from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { extractMcpSettleResponse } from "@x402.kit/core";
import { wrapMcpClient } from "@x402.kit/buyer/mcp";
import { paidTool } from "@x402.kit/seller/mcp";
import { FACILITATOR_URL, balanceOf, buyer, chainClock, krw, wonTerms } from "./fixtures.js";

/** Dig the tool text out of whatever result envelope a client hands back */
function textOf(result: unknown): string | undefined {
  const r = result as { content?: Array<{ text?: string }>; result?: { content?: Array<{ text?: string }> } };
  return r?.content?.[0]?.text ?? r?.result?.content?.[0]?.text;
}

async function legB(): Promise<void> {
  const terms = wonTerms("700000000"); // 700 KRW
  const server = new McpServer({ name: "kit-seller", version: "0.0.0" });
  server.registerTool(
    ...paidTool(
      "kit_tool",
      { accepts: [terms], facilitator: FACILITATOR_URL },
      { description: "kit paid tool" },
      async () => ({ content: [{ type: "text" as const, text: "kit says hi" }] }),
    ),
  );

  const official = createx402MCPClient({
    name: "official-buyer",
    version: "0.0.0",
    schemes: [{ network: "eip155:31337", client: new ExactEvmClientScheme(buyer) }],
    // the default spend controls only know well-known mainnet assets — this is
    // a local test token, so the caps stay off for the conformance run
    spendControls: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await official.connect(clientTransport);

  const before = await balanceOf(buyer.address);
  const result = await official.callTool("kit_tool", {});
  assert.equal(textOf(result), "kit says hi");
  assert.equal(before - (await balanceOf(buyer.address)), 700_000_000n, "the official buyer paid the kit seller");
  console.log("[ok] leg B — official @x402/mcp buyer paid a kit paidTool seller", krw(700_000_000n));

  await official.close?.();
  await server.close();
}

async function legC(): Promise<void> {
  const terms = wonTerms("900000000"); // 900 KRW
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }));
  resourceServer.register("eip155:31337", new ExactEvmServerScheme());
  await resourceServer.initialize();
  // The kit's PaymentRequirements and the official type are the same wire
  // shape; the cast is the package boundary, and the run itself is the proof.
  const withPayment = createPaymentWrapper(resourceServer, {
    accepts: [terms as unknown as OfficialPaymentRequirements],
  });

  const server = new McpServer({ name: "official-seller", version: "0.0.0" });
  server.registerTool(
    "official_tool",
    { description: "official paid tool", inputSchema: { q: z.string().optional() } },
    withPayment(async () => ({ content: [{ type: "text", text: "official says hi" }] })) as never,
  );

  const client = new Client({ name: "kit-buyer", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const paid = wrapMcpClient(client, {
    signer: buyer,
    maxAmount: "1000000000",
    allowAnyAsset: true, // conformance run against the local test token
    clock: chainClock,
  });

  const before = await balanceOf(buyer.address);
  const result = await paid.callTool({ name: "official_tool", arguments: { q: "hi" } });
  assert.equal(textOf(result), "official says hi");
  assert.equal(before - (await balanceOf(buyer.address)), 900_000_000n, "the kit buyer paid the official seller");
  const receipt = extractMcpSettleResponse(result);
  assert.ok(receipt?.success, "the official receipt reads through the kit codec");
  console.log("[ok] leg C — kit wrapMcpClient buyer paid an official createPaymentWrapper seller", krw(900_000_000n));

  await client.close();
  await server.close();
}

async function main(): Promise<void> {
  await legB();
  await legC();
  console.log("\nmcp interop: the kit and the official SDK pay each other in both directions");
}

main().catch((e) => {
  console.error("[fail]", e);
  process.exit(1);
});
