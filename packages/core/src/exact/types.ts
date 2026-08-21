/**
 * Payload types for the `exact` scheme (EIP-3009 path).
 * Spec: schemes/exact/scheme_exact_evm.md §1
 */

import type { Address, Hex } from "viem";

/** EIP-3009 authorization — the six fields the signature covers */
export interface Eip3009Authorization {
  from: Address;
  to: Address;
  /** Atomic-unit string */
  value: string;
  /** Unix seconds, as a string */
  validAfter: string;
  validBefore: string;
  /** Random bytes32. Not sequential — why concurrent payments never block each other */
  nonce: Hex;
}

/** PaymentPayload.payload for (scheme: "exact", eip3009) */
export interface ExactPayload {
  /** 65-byte ECDSA, arbitrary-length ERC-1271, or an ERC-6492 wrapper */
  signature: Hex;
  authorization: Eip3009Authorization;
}

/**
 * Permit2 PermitWitnessTransferFrom authorization — for tokens without
 * EIP-3009. Spec: schemes/exact/scheme_exact_evm.md (assetTransferMethod
 * "permit2"). The witness binds the recipient into the signature, so even the
 * spender proxy cannot redirect funds.
 */
export interface Permit2Authorization {
  /** What the signature permits Permit2 to move */
  permitted: {
    /** Token contract — must equal the terms' asset */
    token: Address;
    /** Atomic-unit string */
    amount: string;
  };
  /** The payer (token owner) */
  from: Address;
  /** The only address allowed to execute — the x402ExactPermit2Proxy */
  spender: Address;
  /** Random uint256 (decimal string). Permit2 unordered nonce — replay guard */
  nonce: string;
  /** Unix seconds (string). Signature expires after this */
  deadline: string;
  /** Recipient terms baked into the signature via Permit2's witness mechanism */
  witness: {
    /** Recipient — must equal the terms' payTo */
    to: Address;
    /** Unix seconds (string). Transfer cannot execute before this */
    validAfter: string;
  };
}

/** PaymentPayload.payload for (scheme: "exact", permit2) */
export interface ExactPermit2Payload {
  /** 65-byte ECDSA, arbitrary-length ERC-1271, or an ERC-6492 wrapper */
  signature: Hex;
  permit2Authorization: Permit2Authorization;
}

/** Either transfer method's payload — what the exact handler actually accepts */
export type AnyExactPayload = ExactPayload | ExactPermit2Payload;
