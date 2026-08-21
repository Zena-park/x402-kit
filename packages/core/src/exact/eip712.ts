/**
 * EIP-712 definitions for `exact`.
 *
 * The type string must be byte-identical to USDC's. A single field-order
 * change alters the typehash, signatures stop recovering, and the promise
 * that "x402 clients connect unmodified" is broken.
 */

import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import type { Eip3009Authorization } from "./types.js";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip712DomainParams {
  /** The token's EIP-712 domain name — comes from the 402's extra.name */
  name: string;
  version: string;
  chainId: number;
  /** Token contract address */
  verifyingContract: Address;
}

/** The typed data being signed. Buyer signing and verification share this function */
export function buildTransferTypedData(
  domain: Eip712DomainParams,
  auth: Eip3009Authorization,
): TypedDataDefinition<typeof TRANSFER_WITH_AUTHORIZATION_TYPES, "TransferWithAuthorization"> {
  return {
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  };
}

/** The digest the signature covers. Target of the golden-vector tests */
export function buildTransferDigest(domain: Eip712DomainParams, auth: Eip3009Authorization): Hex {
  return hashTypedData(buildTransferTypedData(domain, auth));
}
