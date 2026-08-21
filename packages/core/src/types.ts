/**
 * x402 v2 types — byte-exact with spec §5.
 *
 * Spec: x402-specification-v2.md §5 (Types)
 * If a single field name here diverges, standard x402 clients cannot connect.
 *
 * Amounts and timestamps are strings throughout — mandated by the spec, and
 * a guard against JS number precision loss.
 */

import type { Address, Hex } from "viem";

/** CAIP-2 network identifier, e.g. "eip155:84532" (Base Sepolia) */
export type Network = `${string}:${string}`;

/** Protected-resource description. Spec §5.1.2 ResourceInfo */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * Extension slot. Key = extension identifier, value is extension-defined.
 * Kept as `unknown` for interop: the official kit types this loosely and
 * different extensions use different shapes (a bare string vs `{info, schema}`).
 */
export type Extensions = Record<string, unknown>;

/**
 * Payment terms demanded by the seller. Element of the 402 response's `accepts[]`.
 * Scheme-specific data (EIP-712 domain name/version etc.) rides in `extra`.
 */
export interface PaymentRequirements {
  scheme: string;
  network: Network;
  /** Atomic-unit string. With 6 decimals, "10000" = 0.01 tokens */
  amount: string;
  /** Token contract address */
  asset: Address;
  /** Recipient. Baked into the signature — even the facilitator cannot change it */
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: {
    /** EIP-712 domain name. Without it the signing digest cannot be built */
    name?: string;
    /** EIP-712 domain version */
    version?: string;
    /** When unspecified, prefer eip3009 then permit2 (scheme_exact_evm.md) */
    assetTransferMethod?: "eip3009" | "permit2" | "erc7710";
    [key: string]: unknown;
  };
}

/** 402 response body. Base64 JSON in the `PAYMENT-REQUIRED` header. Spec §5.1 */
export interface PaymentRequired {
  x402Version: 2;
  /** Human-readable reason why payment is required */
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Extensions;
}

/**
 * The buyer's payment. Base64 JSON in the `PAYMENT-SIGNATURE` header. Spec §5.2
 * `payload` is scheme-specific — narrowed via the type parameter.
 */
export interface PaymentPayload<P = unknown> {
  x402Version: 2;
  resource?: ResourceInfo;
  /** Echo of the requirements the buyer chose from accepts[] */
  accepted: PaymentRequirements;
  payload: P;
  extensions?: Extensions;
}

/** `/verify` response. Spec §5.4 */
export interface VerifyResponse {
  isValid: boolean;
  /** Failure reason code. Absent on success */
  invalidReason?: string;
  payer?: Address;
}

/** Settlement result. `PAYMENT-RESPONSE` header and `/settle` response. Spec §5.3 */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: Address;
  /** On-chain transaction hash. Empty string on failure */
  transaction: Hex | "";
  network: Network;
  /** Actual settled amount (atomic units). Meaningful for phase-dependent schemes (e.g. upto) */
  amount?: string;
  extensions?: Extensions;
}

/** `/verify` and `/settle` request body. Spec §7.1 */
export interface FacilitatorRequest<P = unknown> {
  x402Version: 2;
  paymentPayload: PaymentPayload<P>;
  paymentRequirements: PaymentRequirements;
}

/** `/supported` response. Spec §7.3 */
export interface SupportedResponse {
  kinds: Array<{
    x402Version: 2;
    scheme: string;
    network: Network;
    extra?: Record<string, unknown>;
  }>;
  extensions: string[];
  /** Signers (gas-paying addresses) per CAIP pattern, e.g. { "eip155:*": ["0x…"] } */
  signers: Record<string, Address[]>;
}
