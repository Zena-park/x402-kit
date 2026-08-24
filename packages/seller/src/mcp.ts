/**
 * MCP adapter — paid tools (transports-v2/mcp.md).
 *
 *   import { paidTool } from "@x402.kit/seller/mcp";
 *   server.registerTool(...paidTool("financial_analysis", { accepts, facilitator }, config, handler));
 *
 * Typed structurally so @modelcontextprotocol/sdk is not a dependency — any
 * server whose registerTool takes (name, config, handler) and calls the
 * handler with (args, extra-carrying-`_meta`) works. Payment terms travel as
 * an `isError: true` tool result; the buyer's payment arrives in
 * `_meta["x402/payment"]`; the receipt leaves in `_meta["x402/payment-response"]`.
 *
 * upto: a handler that knows the real charge puts
 * `_meta: { "x402kit/settlement-overrides": { amount } }` on its result; the
 * wrapper reads it, strips it, and settles that amount — the MCP twin of the
 * HTTP `Settlement-Overrides` header.
 */

import {
  ErrorReasonExtra,
  MCP_META_PAYMENT,
  attachMcpSettleResponse,
  buildMcpPaymentRequired,
  buildPaymentRequired,
  mcpToolResourceUrl,
  type McpToolResult,
  type ResourceInfo,
} from "@x402.kit/core";
import { MAX_PAYMENT_HEADER_BYTES, createPaywall, type CaptureOptions, type PaywallOptions } from "./paywall.js";

/** Result `_meta` key a handler sets to pick the settle-time amount (upto). Kit extension, not spec */
export const MCP_META_SETTLEMENT_OVERRIDES = "x402kit/settlement-overrides";

/** Spec-worded reason on the initial payment-required result */
const PAYMENT_REQUIRED_ERROR = "Payment required to access this resource";

/** The slice of the MCP SDK's RequestHandlerExtra this adapter reads */
export interface McpHandlerExtra {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export type McpToolHandler<Args = Record<string, unknown>> = (
  args: Args,
  extra: McpHandlerExtra,
) => McpToolResult | Promise<McpToolResult>;

/**
 * The wrapped handler's type — deliberately loose so the tuple satisfies every
 * `registerTool` overload of the MCP SDK (schema-less tools get `(extra)`,
 * schema-carrying ones `(args, extra)`) without this package depending on the
 * SDK's types. The safety that matters lives on the INNER handler you write.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpRegisteredHandler = (...call: any[]) => Promise<any>;

export interface McpPaywallOptions extends Omit<PaywallOptions, "resource" | "settle"> {
  /** Resource named in the payment terms. Default: { url: "mcp://tool/<name>" } */
  resource?: ResourceInfo;
  /**
   * "sync" (default): verify + settle before the handler runs.
   * "after-handler": run the handler first, settle after it succeeds. A
   * handler that throws never charges the buyer; a settlement that then
   * definitively fails withholds the tool's content and returns only the
   * payment error (spec rule — the atomicity HTTP after-handler cannot offer,
   * because there the response is already on the wire).
   */
  settle?: "sync" | "after-handler";
}

/** Read and strip the handler's settle-amount override from its result `_meta` */
function takeOverrides(result: McpToolResult): { result: McpToolResult; overrides?: CaptureOptions } {
  const meta = result._meta;
  if (meta?.[MCP_META_SETTLEMENT_OVERRIDES] === undefined) return { result };
  const { [MCP_META_SETTLEMENT_OVERRIDES]: raw, ...rest } = meta;
  const stripped: McpToolResult = { ...result };
  if (Object.keys(rest).length > 0) stripped._meta = rest;
  else delete stripped._meta;
  const amount = typeof raw === "object" && raw !== null ? (raw as { amount?: unknown }).amount : undefined;
  return { result: stripped, ...(typeof amount === "string" ? { overrides: { amount } } : {}) };
}

/**
 * Wrap one tool with the paywall. Returns the (name, config, handler) tuple
 * `registerTool` takes, with the handler replaced by the paywalled one.
 */
export function paidTool<Args, Config>(
  name: string,
  options: McpPaywallOptions,
  config: Config,
  handler: McpToolHandler<Args>,
): [name: string, config: Config, handler: McpRegisteredHandler] {
  const { resource: resourceOption, ...paywallOptions } = options;
  const resource: ResourceInfo = resourceOption ?? { url: mcpToolResourceUrl(name) };
  const paywall = createPaywall(paywallOptions);

  // The MCP SDK calls a schema-less tool's handler with (extra) alone and a
  // schema-carrying one with (args, extra) — read `extra` from whichever
  // position it holds and pass the original call through untouched.
  const wrapped = (async (...callArgs: unknown[]) => {
    const extra = (callArgs.length > 1 ? callArgs[1] : callArgs[0]) as McpHandlerExtra | undefined;
    const run = (): McpToolResult | Promise<McpToolResult> =>
      (handler as (...a: unknown[]) => McpToolResult | Promise<McpToolResult>)(...callArgs);
    const raw = extra?._meta?.[MCP_META_PAYMENT];
    // The HTTP transport's size guard, applied to the parsed object: an
    // oversized "payment" is refused (null fails schema validation →
    // invalid_payload) before schema work and before it could ever be
    // forwarded to the facilitator. Measured on the raw JSON, so the cap is
    // slightly more permissive than HTTP's base64 measurement — both bound
    // the same processing cost. An in-process transport can hand over values
    // JSON never could (circular references, functions) — a failed or
    // undefined measurement is refused the same way, never thrown.
    let payment: unknown = raw;
    if (raw !== undefined) {
      try {
        if ((JSON.stringify(raw)?.length ?? Infinity) > MAX_PAYMENT_HEADER_BYTES) payment = null;
      } catch {
        payment = null;
      }
    }

    const decision = await paywall.checkPayment(payment, resource, PAYMENT_REQUIRED_ERROR);
    if (!decision.paid) {
      if (decision.status === 402) return buildMcpPaymentRequired(decision.paymentRequired);
      // Facilitator outage: an error result deliberately NOT payment-required-
      // shaped (no x402 markers), so clients do not try to pay it.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "facilitator_unavailable", retryAfter: decision.retryAfter }),
          },
        ],
      };
    }

    if (!decision.capture) {
      // sync — already settled; attach the receipt to whatever the tool returns
      const result = await run();
      return decision.settlement ? attachMcpSettleResponse(result, decision.settlement) : result;
    }

    // after-handler: a throwing handler never charges the buyer (capture is
    // never called; the replay claim expires on its own TTL).
    const { result, overrides } = takeOverrides(await run());
    const captured = await decision.capture(overrides);
    if (captured.ok) return attachMcpSettleResponse(result, captured.settlement);
    // Pending is not a failure: the tx may still land and the claim is kept —
    // deliver the goods, just without a receipt.
    if (captured.settlement.errorReason === ErrorReasonExtra.SETTLEMENT_PENDING) return result;
    // Definite settlement failure after execution: withhold the content and
    // return only the payment error (spec §Settlement Failure).
    return buildMcpPaymentRequired(
      buildPaymentRequired({ resource, accepts: options.accepts, error: "Settlement failed" }),
    );
  }) satisfies McpRegisteredHandler;

  return [name, config, wrapped];
}
