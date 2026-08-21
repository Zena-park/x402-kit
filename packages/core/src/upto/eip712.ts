/**
 * EIP-712 definitions for `upto`. Same Permit2 domain and stub as
 * exact/permit2; the witness struct gains a `facilitator` field, so the
 * witnessTypeString (and therefore every digest) differs. Golden test in
 * upto.test.ts pins the encoding against the contract's typehash.
 */

import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import { PERMIT2_ADDRESS, type Permit2DomainParams } from "../exact/permit2Eip712.js";
import type { UptoPermit2Authorization } from "./types.js";

/**
 * x402UptoPermit2Proxy — the only spender an upto signature names. Enforces
 * `amount ≤ permitted.amount` and `msg.sender == witness.facilitator` on-chain.
 * CREATE2, same address on every supported chain (scheme_upto_evm.md annex).
 */
export const X402_UPTO_PERMIT2_PROXY_ADDRESS: Address = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";

export const UPTO_PERMIT2_WITNESS_TRANSFER_TYPES = {
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
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

/** The witnessTypeString the proxy passes to Permit2 — contract-verbatim */
export const UPTO_PERMIT2_WITNESS_TYPE_STRING =
  "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)";

export function buildUptoTypedData(
  params: Permit2DomainParams,
  auth: UptoPermit2Authorization,
): TypedDataDefinition<typeof UPTO_PERMIT2_WITNESS_TRANSFER_TYPES, "PermitWitnessTransferFrom"> {
  return {
    domain: {
      name: "Permit2",
      chainId: params.chainId,
      verifyingContract: params.permit2Address ?? PERMIT2_ADDRESS,
    },
    types: UPTO_PERMIT2_WITNESS_TRANSFER_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
      spender: auth.spender,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: {
        to: auth.witness.to,
        facilitator: auth.witness.facilitator,
        validAfter: BigInt(auth.witness.validAfter),
      },
    },
  };
}

/** The digest the signature covers. Target of the golden-vector tests */
export function buildUptoDigest(params: Permit2DomainParams, auth: UptoPermit2Authorization): Hex {
  return hashTypedData(buildUptoTypedData(params, auth));
}
