/**
 * MCP client wrapper — pay for tools (transports-v2/mcp.md).
 *
 *   import { wrapMcpClient } from "@x402.kit/buyer/mcp";
 *   const client = wrapMcpClient(mcpClient, { signer, maxAmount, maxTotalAmount, assets });
 *
 * Typed structurally: anything with `callTool(params)` is wrappable — the
 * official @modelcontextprotocol/sdk Client included, without depending on it.
 * Same policy surface and rules as wrapFetch: refuses to sign without a
 * per-payment cap and an asset allowlist, the budget counts what was signed,
 * one paid retry only. Policy refusals never throw — the seller's
 * payment-required result is returned untouched and `onSkipped` reports why.
 */

import {
  attachMcpPayment,
  extractMcpPaymentRequired,
  extractMcpSettleResponse,
  type McpToolResult,
} from "@x402.kit/core";
import { assertBuyerPolicy, createSpendTracker, preparePayment, type WrapFetchOptions } from "./wrapFetch.js";

/** Same policy options as wrapFetch — one shared vocabulary for both transports */
export type WrapMcpClientOptions = WrapFetchOptions;

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The slice of an MCP client this wrapper needs */
export interface McpClientLike {
  callTool(params: McpCallToolParams, ...rest: never[]): Promise<unknown>;
}

/**
 * Wrap an MCP client so paid tool calls are paid under the buyer's caps.
 * Every other method passes through to the wrapped client untouched.
 */
export function wrapMcpClient<C extends McpClientLike>(client: C, options: WrapMcpClientOptions): C {
  assertBuyerPolicy(options);
  const spend = createSpendTracker(options.maxTotalAmount);

  const callTool = async (params: McpCallToolParams, ...rest: unknown[]): Promise<unknown> => {
    const first = await client.callTool(params, ...(rest as never[]));

    const required = extractMcpPaymentRequired(first);
    if (!required) return first; // an ordinary result or error — not ours
    if (!required.ok) {
      // Claims to be a payment request but fails the schema — never sign it.
      options.onSkipped?.(`malformed payment terms: ${required.error}`, []);
      return first;
    }

    const accepts = required.value.accepts;
    // The terms' resource rides inside the signed-payload envelope (as the
    // spec's example does) so the seller's bindResource can pin it to this tool.
    const prepared = await preparePayment(accepts, options, spend, required.value.resource);
    if ("skipped" in prepared) {
      options.onSkipped?.(prepared.skipped, accepts);
      return first;
    }

    const paid: McpCallToolParams = { ...params, _meta: attachMcpPayment(params._meta, prepared.payload) };

    let second: unknown;
    try {
      second = await client.callTool(paid, ...(rest as never[]));
    } catch (e) {
      prepared.refund(); // never reached the seller — nobody holds the signature
      throw e;
    }

    // The wrapFetch rule, translated: onPaid only for a delivered result. Any
    // isError retry result — a fresh payment-required (the seller refused and
    // holds the signature — the budget stays charged), a facilitator outage,
    // or a tool error — is not a payment the buyer's accounting should record.
    const errored =
      typeof second === "object" && second !== null && (second as McpToolResult).isError === true;
    if (!errored) {
      options.onPaid?.(prepared.chosen, extractMcpSettleResponse(second));
    }
    return second;
  };

  // Bound methods are cached so identities are stable (paid.close === paid.close)
  // and property access does not allocate; the wrapped client keeps working when
  // its methods are destructured.
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "callTool") return callTool;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (!bound.has(prop)) bound.set(prop, (value as (...a: unknown[]) => unknown).bind(target));
      return bound.get(prop);
    },
  }) as C;
}
