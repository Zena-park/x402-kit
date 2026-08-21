/**
 * Runtime validation for the x402 v2 wire types (zod).
 *
 * Field names and structure mirror the official `@x402/core/schemas`
 * byte-for-byte (see the conformance test), so a validated object here is a
 * valid object there. We are deliberately *stricter* in two places:
 *   - `amount` must be a plain atomic-unit decimal (`^\d+$`), not any string —
 *     this is what stops `BigInt("abc")` from throwing deep in the pipeline and
 *     `"0x10"`/`"-1"` from aliasing or bypassing a bound.
 *   - `network` must be CAIP-2 (`ns:ref`).
 *
 * These are validators for untrusted input at the edges (facilitator HTTP,
 * decoded headers in seller/buyer). Types are inferred so nothing downstream
 * changes; the hand-written interfaces in types.ts remain the public shape.
 */

import { z } from "zod";

/** Non-empty string */
const NonEmpty = z.string().min(1);

/** Atomic-unit amount — plain decimal, no hex/negative/exponent */
export const AmountSchema = z.string().regex(/^(0|[1-9]\d*)$/, "amount must be a decimal atomic-unit string");

/** 0x-prefixed 20-byte address (checksum-agnostic; sameAddress handles casing) */
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x EVM address");

/** CAIP-2 network id, e.g. "eip155:84532" */
export const NetworkSchema = z
  .string()
  .min(3)
  .refine((v) => v.includes(":"), { message: "network must be CAIP-2 (namespace:reference)" });

/** Optional, nullable extension/extra map — matches the official OptionalAny */
const OptionalAny = z.record(z.unknown()).optional().nullable();

export const ResourceInfoSchema = z.object({
  url: NonEmpty,
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const PaymentRequirementsSchema = z.object({
  scheme: NonEmpty,
  network: NetworkSchema,
  amount: AmountSchema,
  asset: AddressSchema,
  payTo: AddressSchema,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: OptionalAny,
});

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: OptionalAny,
});

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.record(z.unknown()),
  extensions: OptionalAny,
});

export const FacilitatorRequestSchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

/** A safe-parse result: the value, or a one-line reason */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function toResult<T>(parsed: z.SafeParseReturnType<unknown, T>): ParseResult<T> {
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".");
  return { ok: false, error: path ? `${path}: ${first?.message}` : (first?.message ?? "invalid") };
}

export const parsePaymentRequired = (v: unknown): ParseResult<z.infer<typeof PaymentRequiredSchema>> =>
  toResult(PaymentRequiredSchema.safeParse(v));

export const parsePaymentPayload = (v: unknown): ParseResult<z.infer<typeof PaymentPayloadSchema>> =>
  toResult(PaymentPayloadSchema.safeParse(v));

export const parseFacilitatorRequest = (v: unknown): ParseResult<z.infer<typeof FacilitatorRequestSchema>> =>
  toResult(FacilitatorRequestSchema.safeParse(v));
