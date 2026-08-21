/**
 * Low-level builder for the 402 response object.
 *
 * Must be usable without any HTTP middleware — a POS terminal carries this
 * object inside a QR code (scenarios §4-1). The middleware presets are thin
 * shells around this function.
 */

import type { PaymentRequired, PaymentRequirements, ResourceInfo } from "./types.js";

export interface PaymentRequiredParams {
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  /** Human-readable reason why payment is required — for the 402 body */
  error?: string;
}

export function buildPaymentRequired(params: PaymentRequiredParams): PaymentRequired {
  if (params.accepts.length === 0) {
    throw new Error("accepts is empty — a 402 without payment terms is meaningless");
  }
  return {
    x402Version: 2,
    ...(params.error !== undefined ? { error: params.error } : {}),
    resource: params.resource,
    accepts: params.accepts,
  };
}
