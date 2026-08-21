/**
 * Wire encoding — HTTP transport spec (transports-v2/http.md).
 *
 * All three headers carry base64(JSON). Protocol data travels entirely in
 * headers; response bodies are the server's own concern.
 */

import type { PaymentPayload, PaymentRequired, SettleResponse } from "./types.js";
import { parsePaymentPayload, parsePaymentRequired, type ParseResult } from "./schemas.js";

/** Server → client. Payment terms accompanying the 402 */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
/** Client → server. Signed payment payload */
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
/** Server → client. Settlement result */
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function fromBase64<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
}

export const encodePaymentRequired = (v: PaymentRequired): string => toBase64(v);
export const decodePaymentRequired = (s: string): PaymentRequired => fromBase64(s);

export const encodePaymentPayload = <P>(v: PaymentPayload<P>): string => toBase64(v);
export const decodePaymentPayload = <P = unknown>(s: string): PaymentPayload<P> => fromBase64(s);

/**
 * Decode + validate a base64 PaymentRequired header from untrusted input.
 * Never throws — malformed input returns `{ ok: false, error }`, so a seller
 * or facilitator cannot be crashed by a crafted header.
 */
export function decodePaymentRequiredSafe(s: string): ParseResult<PaymentRequired> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "not valid base64 JSON" };
  }
  return parsePaymentRequired(raw) as ParseResult<PaymentRequired>;
}

/** Decode + validate a base64 PaymentPayload header from untrusted input. Never throws. */
export function decodePaymentPayloadSafe(s: string): ParseResult<PaymentPayload> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "not valid base64 JSON" };
  }
  return parsePaymentPayload(raw) as ParseResult<PaymentPayload>;
}

export const encodeSettleResponse = (v: SettleResponse): string => toBase64(v);
export const decodeSettleResponse = (s: string): SettleResponse => fromBase64(s);

/**
 * Decode a base64 PAYMENT-RESPONSE header without throwing — a malformed
 * server receipt must never fail a buyer's already-successful (paid) request.
 * Returns undefined on any parse error.
 */
export function decodeSettleResponseSafe(s: string): SettleResponse | undefined {
  try {
    const v = fromBase64<SettleResponse>(s);
    return v && typeof v === "object" && typeof v.success === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}
