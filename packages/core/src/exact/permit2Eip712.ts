/**
 * EIP-712 definitions for `exact` with assetTransferMethod "permit2".
 *
 * The signature verifies against the canonical Permit2 contract, so the full
 * encoded type must be byte-identical to what Permit2 hashes on-chain:
 * its PermitWitnessTransferFrom stub concatenated with the spec's witness
 * type string. viem encodes referenced types in EIP-712 alphabetical order
 * (TokenPermissions before Witness) — exactly the concatenation below; the
 * golden test in permit2.test.ts pins this equivalence.
 */

import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import type { Permit2Authorization } from "./types.js";

/** Canonical Permit2 — the same CREATE2 address on every major EVM chain */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * x402ExactPermit2Proxy — the only spender an exact/permit2 signature names.
 * It forwards funds strictly to `witness.to`, which is what keeps the
 * recipient facilitator-proof. Deployed via CREATE2 to the same address on
 * all supported chains (scheme_exact_evm.md).
 */
export const X402_PERMIT2_PROXY_ADDRESS: Address = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";

export const PERMIT2_WITNESS_TRANSFER_TYPES = {
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
} as const;

/** The witnessTypeString Permit2 appends to its stub — spec-verbatim */
export const PERMIT2_WITNESS_TYPE_STRING =
  "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

export interface Permit2DomainParams {
  chainId: number;
  /** Override only for private/test deployments. Default: canonical Permit2 */
  permit2Address?: Address;
}

/** The typed data being signed. Buyer signing and verification share this function */
export function buildPermit2TypedData(
  params: Permit2DomainParams,
  auth: Permit2Authorization,
): TypedDataDefinition<typeof PERMIT2_WITNESS_TRANSFER_TYPES, "PermitWitnessTransferFrom"> {
  return {
    // Permit2's domain has no version field — { name, chainId, verifyingContract } only
    domain: {
      name: "Permit2",
      chainId: params.chainId,
      verifyingContract: params.permit2Address ?? PERMIT2_ADDRESS,
    },
    types: PERMIT2_WITNESS_TRANSFER_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: auth.permitted.token,
        amount: BigInt(auth.permitted.amount),
      },
      spender: auth.spender,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: {
        to: auth.witness.to,
        validAfter: BigInt(auth.witness.validAfter),
      },
    },
  };
}

/** The digest the signature covers. Target of the golden-vector tests */
export function buildPermit2Digest(params: Permit2DomainParams, auth: Permit2Authorization): Hex {
  return hashTypedData(buildPermit2TypedData(params, auth));
}
