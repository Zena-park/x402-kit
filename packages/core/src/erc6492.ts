/**
 * ERC-6492 — signatures from smart accounts that are not deployed yet.
 *
 * Parsing is delegated to viem (no parallel implementation of the same
 * algorithm). This adapter maps field names to the kit's vocabulary
 * (factory · innerSignature) and makes "was it wrapped" an explicit boolean.
 *
 * verify can judge the wrapper as-is (viem uses a deployless call), but
 * settle needs the account deployed first — the token's SignatureChecker
 * requires account code — which is why Erc6492Settler bundles deploy and
 * settlement into one transaction.
 */

import {
  isErc6492Signature,
  parseErc6492Signature as viemParseErc6492Signature,
  type Address,
  type Hex,
} from "viem";

export { isErc6492Signature };

export interface Erc6492Signature {
  /** Was this a 6492 wrapper */
  wrapped: boolean;
  /** Account factory. Undefined when not wrapped */
  factory?: Address;
  /** Deployment calldata */
  factoryCalldata?: Hex;
  /** The unwrapped inner signature. This is what goes to the token */
  innerSignature: Hex;
}

/** Unwrap. Non-wrapped signatures pass through as `innerSignature` unchanged */
export function parseErc6492Signature(signature: Hex): Erc6492Signature {
  if (!isErc6492Signature(signature)) {
    return { wrapped: false, innerSignature: signature };
  }
  const { address, data, signature: inner } = viemParseErc6492Signature(signature);
  return {
    wrapped: true,
    ...(address !== undefined ? { factory: address } : {}),
    ...(data !== undefined ? { factoryCalldata: data } : {}),
    innerSignature: inner,
  };
}
