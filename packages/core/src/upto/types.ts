/**
 * Payload types for the `upto` scheme (Permit2 only).
 * Spec: schemes/upto/scheme_upto_evm.md
 *
 * The buyer signs a CAP; the seller settles any amount ≤ cap, once. The
 * witness binds recipient AND facilitator into the signature: only the named
 * facilitator can execute, and only to `witness.to`.
 */

import type { Address, Hex } from "viem";

export interface UptoPermit2Witness {
  /** Recipient — must equal the terms' payTo */
  to: Address;
  /** The only facilitator allowed to execute — from /supported `extra.facilitatorAddress` */
  facilitator: Address;
  /** Unix seconds (string). Transfer cannot execute before this */
  validAfter: string;
}

export interface UptoPermit2Authorization {
  permitted: {
    /** Token contract — must equal the terms' asset */
    token: Address;
    /** The CAP (atomic-unit string) — equals the terms' amount at verify time */
    amount: string;
  };
  /** The payer (token owner) */
  from: Address;
  /** The only address allowed to execute — the x402UptoPermit2Proxy */
  spender: Address;
  /** Random uint256 (decimal string). Permit2 unordered nonce — single use regardless of amount */
  nonce: string;
  /** Unix seconds (string). Signature expires after this */
  deadline: string;
  witness: UptoPermit2Witness;
}

/** PaymentPayload.payload for scheme "upto" */
export interface UptoPayload {
  /** 65-byte ECDSA, arbitrary-length ERC-1271, or an ERC-6492 wrapper */
  signature: Hex;
  permit2Authorization: UptoPermit2Authorization;
}
