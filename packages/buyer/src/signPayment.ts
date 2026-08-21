/**
 * Low-level signing — for buyers outside plain HTTP fetch flows.
 *
 * A wallet app scanning a POS QR code decodes the PaymentRequired itself,
 * calls signPayment on the chosen terms, and sends the encoded result back
 * over whatever channel the terminal offers.
 */

import type { Address } from "viem";
import {
  exactScheme,
  resolveHandler,
  uptoScheme,
  type AnySchemeHandler,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
} from "@x402.kit/core";

/** Schemes a buyer pays with unless told otherwise — exact (a price) and upto (a cap) */
export const DEFAULT_BUYER_SCHEMES: AnySchemeHandler[] = [exactScheme, uptoScheme];

export interface SignPaymentOptions {
  signer: PaymentSigner;
  /** Schemes this buyer can pay with. Default: [exactScheme, uptoScheme] */
  schemes?: AnySchemeHandler[];
  /** Reference time (unix seconds) — pass chain time when wall clocks can't be trusted */
  now?: number;
  /** Cap the on-chain validity window (seconds), overriding the server's maxTimeoutSeconds */
  validForSeconds?: number;
  /** Explicit validity start (unix seconds) — pins a future window (schedules). Default: immediate */
  validAfter?: number;
  /**
   * exact/permit2 only: spender proxy override for private/test deployments.
   * Deliberately an option and never read from the 402 — a seller-supplied
   * spender could route funds anywhere.
   */
  permit2Proxy?: Address;
  /** exact/permit2 only: Permit2 contract override for private/test deployments */
  permit2Address?: Address;
  /** upto only: spender proxy override. Same rule as permit2Proxy — never wire-controlled */
  uptoPermit2Proxy?: Address;
}

export async function signPayment(
  requirements: PaymentRequirements,
  options: SignPaymentOptions,
): Promise<PaymentPayload> {
  const resolved = resolveHandler(options.schemes ?? DEFAULT_BUYER_SCHEMES, requirements);
  if ("error" in resolved) {
    throw new Error(`cannot sign ${requirements.scheme} on ${requirements.network}: ${resolved.error}`);
  }
  return resolved.handler.buildPayload(requirements, {
    signer: options.signer,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.validForSeconds !== undefined ? { validForSeconds: options.validForSeconds } : {}),
    ...(options.validAfter !== undefined ? { validAfter: options.validAfter } : {}),
    ...(options.permit2Proxy ? { permit2Proxy: options.permit2Proxy } : {}),
    ...(options.permit2Address ? { permit2Address: options.permit2Address } : {}),
    ...(options.uptoPermit2Proxy ? { uptoPermit2Proxy: options.uptoPermit2Proxy } : {}),
  });
}
