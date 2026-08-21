/**
 * Frozen fixtures from the spec's own examples.
 * Source: x402-specification-v2.md §5.1.1 · §5.2.1 (local clone, 2026-08-19).
 * If the spec changes a field, the diff against this file surfaces it.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Eip712DomainParams, ExactPayload, PaymentPayload, PaymentRequired, PaymentRequirements } from "../src/index.js";

export const CHAIN_ID = 84532; // Base Sepolia — the network in the spec examples

/** anvil #0 — signing key for tests */
export const testAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

export const specPaymentRequired: PaymentRequired = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

export const specRequirements: PaymentRequirements = specPaymentRequired.accepts[0]!;

export function domainFor(req: PaymentRequirements): Eip712DomainParams {
  return {
    name: req.extra?.name as string,
    version: req.extra?.version as string,
    chainId: CHAIN_ID,
    verifyingContract: req.asset,
  };
}

// `accepted` echoes the requirements and `resource` echoes the 402's —
// referenced, not copied, exactly as the spec describes the relationship
export const specPaymentPayload: PaymentPayload<ExactPayload> = {
  x402Version: 2,
  resource: specPaymentRequired.resource,
  accepted: specRequirements,
  payload: {
    signature:
      "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  },
};
