/**
 * Wire encoding — MCP transport spec (transports-v2/mcp.md).
 *
 * Where HTTP carries base64(JSON) in headers, MCP carries the same objects as
 * plain JSON: payment terms ride in an `isError: true` tool result, the signed
 * payment in `_meta["x402/payment"]`, and the settlement receipt in
 * `_meta["x402/payment-response"]`. This module is pure JSON assembly and
 * validation — it has no dependency on any MCP SDK; tool results and `_meta`
 * are typed structurally.
 */

import type { PaymentPayload, PaymentRequired, SettleResponse } from "./types.js";
import { parsePaymentPayload, parsePaymentRequired, type ParseResult } from "./schemas.js";

/** Request `params._meta` key carrying the buyer's PaymentPayload (plain JSON) */
export const MCP_META_PAYMENT = "x402/payment";
/** Response `result._meta` key carrying the SettleResponse (plain JSON) */
export const MCP_META_PAYMENT_RESPONSE = "x402/payment-response";

/** The slice of an MCP tool result this transport reads and writes */
export interface McpToolResult {
  isError?: boolean;
  /** Direct PaymentRequired object (spec: REQUIRED on payment-required results) */
  structuredContent?: Record<string, unknown>;
  /** Text mirror of structuredContent for clients without structured access */
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Default resource URL for a paid tool: `mcp://tool/<name>` (spec examples) */
export function mcpToolResourceUrl(toolName: string): string {
  return `mcp://tool/${toolName}`;
}

/**
 * Assemble the payment-required tool result. The spec requires the same
 * PaymentRequired in BOTH `structuredContent` (object) and `content[0].text`
 * (its JSON.stringify) so clients without structured-content access still work.
 */
export function buildMcpPaymentRequired(body: PaymentRequired): McpToolResult {
  return {
    isError: true,
    structuredContent: body as unknown as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

/**
 * Read a PaymentRequired out of a tool result, the way the spec tells clients
 * to: prefer `structuredContent` when it carries the x402 markers, fall back
 * to parsing `content[0].text` as JSON.
 *
 * Returns undefined when the result does not claim to be a payment request at
 * all (an ordinary tool result or error — pass it through). Returns
 * `{ ok: false }` when it claims to be one but fails schema validation — the
 * caller must not sign anything based on it.
 */
export function extractMcpPaymentRequired(result: unknown): ParseResult<PaymentRequired> | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as McpToolResult;
  if (r.isError !== true) return undefined;

  const marked = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && "x402Version" in v && "accepts" in v;

  if (marked(r.structuredContent)) {
    return parsePaymentRequired(r.structuredContent) as ParseResult<PaymentRequired>;
  }
  const text = r.content?.[0]?.type === "text" ? r.content[0].text : undefined;
  if (typeof text !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined; // ordinary textual error, not a payment request
  }
  if (!marked(raw)) return undefined;
  return parsePaymentRequired(raw) as ParseResult<PaymentRequired>;
}

/**
 * Read + validate the buyer's payment from a request's `_meta`. Never throws —
 * absent returns undefined, present-but-malformed returns `{ ok: false }`
 * (the seller answers with a fresh payment-required, never a crash).
 */
export function extractMcpPayment(meta: unknown): ParseResult<PaymentPayload> | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[MCP_META_PAYMENT];
  if (value === undefined) return undefined;
  return parsePaymentPayload(value) as ParseResult<PaymentPayload>;
}

/** Attach the signed payment to a request's `_meta`, preserving existing keys */
export function attachMcpPayment(
  meta: Record<string, unknown> | undefined,
  payload: PaymentPayload,
): Record<string, unknown> {
  return { ...meta, [MCP_META_PAYMENT]: payload };
}

/** Attach the settlement receipt to a tool result's `_meta`, preserving existing keys */
export function attachMcpSettleResponse(result: McpToolResult, settlement: SettleResponse): McpToolResult {
  return { ...result, _meta: { ...result._meta, [MCP_META_PAYMENT_RESPONSE]: settlement } };
}

/**
 * Read the settlement receipt from a tool result without throwing — a
 * malformed server receipt must never fail a buyer's already-paid call.
 */
export function extractMcpSettleResponse(result: unknown): SettleResponse | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const meta = (result as McpToolResult)._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const v = meta[MCP_META_PAYMENT_RESPONSE];
  return v && typeof v === "object" && typeof (v as SettleResponse).success === "boolean"
    ? (v as SettleResponse)
    : undefined;
}
