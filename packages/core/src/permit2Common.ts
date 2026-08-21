/**
 * What every Permit2-settled scheme (exact/permit2, upto) shares: the payload
 * shape gate, numeric field parsing, the `permit` tuple the proxies take, and
 * the one on-chain state check — six independent reads fired in parallel and
 * judged cheapest-first. Scheme-specific matching (amount semantics, spender,
 * witness fields, reason vocabulary) stays in the scheme; this module owns
 * only the Permit2 invariants, so a fix lands once.
 */

import { isAddress, isHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { ErrorReason, ErrorReasonExtra } from "./errors.js";
import { parseErc6492Signature } from "./erc6492.js";
import { ERC20_ABI, PERMIT2_ABI } from "./exact/abi.js";
import { PERMIT2_ADDRESS } from "./exact/permit2Eip712.js";
import type { ChainContext } from "./scheme.js";
import type { PaymentPayload } from "./types.js";
import { parseAmount } from "./utils.js";

/** The fields every Permit2 witness-transfer authorization has, whatever its witness adds */
export interface Permit2AuthorizationBase {
  permitted: { token: Address; amount: string };
  from: Address;
  spender: Address;
  nonce: string;
  deadline: string;
  witness: { to: Address; validAfter: string };
}

/**
 * Shape gate shared by verify AND settle: the wire schema only guarantees
 * `payload` is an object, so the authorization and its nested objects can be
 * absent. Passes only when `from` is a real address and the signature is hex —
 * nothing downstream dereferences a raw field before this.
 */
export function wellFormedPermit2<A extends Permit2AuthorizationBase>(
  payload: PaymentPayload<{ signature: Hex; permit2Authorization: A }>,
): { auth: A; signature: Hex } | undefined {
  const auth = payload.payload?.permit2Authorization;
  const signature = payload.payload?.signature;
  if (
    !auth ||
    typeof auth !== "object" ||
    !isAddress(auth.from ?? "") ||
    !isHex(signature) ||
    typeof auth.permitted !== "object" ||
    auth.permitted === null ||
    typeof auth.witness !== "object" ||
    auth.witness === null
  ) {
    return undefined;
  }
  return { auth, signature };
}

export interface Permit2Fields {
  /** permitted.amount */
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  validAfter: bigint;
}

/** The four numeric wire fields, or undefined if any is malformed (hex/negative/oversized) */
export function parsePermit2Fields(auth: Permit2AuthorizationBase): Permit2Fields | undefined {
  const amount = parseAmount(auth.permitted?.amount);
  const nonce = parseAmount(auth.nonce);
  const deadline = parseAmount(auth.deadline);
  const validAfter = parseAmount(auth.witness?.validAfter);
  if (amount === undefined || nonce === undefined || deadline === undefined || validAfter === undefined) return undefined;
  return { amount, nonce, deadline, validAfter };
}

/** Permit2 contract address — default in one place so build/verify/settle agree */
export function permit2Contract(src: { permit2Address?: Address }): Address {
  return src.permit2Address ?? PERMIT2_ADDRESS;
}

/** The `PermitTransferFrom` tuple the x402 proxies take (spender is msg.sender, so it is omitted) */
export function permit2PermitArg(auth: Permit2AuthorizationBase) {
  return {
    permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
    nonce: BigInt(auth.nonce),
    deadline: BigInt(auth.deadline),
  };
}

/** The bytes the proxy forwards to Permit2 — an ERC-6492 wrapper is unwrapped first */
export function permit2InnerSignature(signature: Hex): Hex {
  return parseErc6492Signature(signature).innerSignature;
}

export interface Permit2StateQuery {
  payer: Address;
  asset: Address;
  permit2: Address;
  /** The spender proxy — must hold code, or a settle would "succeed" moving nothing */
  proxy: Address;
  /** Allowance and balance the payer must cover (exact: the amount; upto: the cap) */
  required: bigint;
  fields: Permit2Fields;
  typedData: TypedDataDefinition;
  signature: Hex;
  /** Scheme vocabulary for the three time/signature verdicts */
  reasons: { notYetValid: string; expired: string; badSignature: string };
  /** Seconds the deadline must still have left (verify's settle-window margin; 0 at settle) */
  minRemaining: bigint;
}

export interface Permit2StateVerdict {
  invalidReason?: string;
  /** Chain height the verdict was judged at — settle's reconciliation lower bound */
  blockNumber?: bigint | undefined;
}

/**
 * Six independent on-chain calls — fired in parallel (they coalesce into one
 * batched round trip), judged cheapest-first: proxy code → validAfter →
 * deadline → nonce → signature → allowance → balance. verifyTypedData covers
 * EOA, ERC-1271, and ERC-6492 alike. Time is CHAIN time — the contract judges
 * by block.timestamp.
 */
export async function checkPermit2State(ctx: ChainContext, q: Permit2StateQuery): Promise<Permit2StateVerdict> {
  const { nonce, deadline, validAfter } = q.fields;
  const [block, nonceBitmap, balance, allowance, signatureValid, proxyCode] = await Promise.all([
    ctx.publicClient.getBlock({ blockTag: "latest" }),
    ctx.publicClient.readContract({ address: q.permit2, abi: PERMIT2_ABI, functionName: "nonceBitmap", args: [q.payer, nonce >> 8n] }),
    ctx.publicClient.readContract({ address: q.asset, abi: ERC20_ABI, functionName: "balanceOf", args: [q.payer] }),
    ctx.publicClient.readContract({ address: q.asset, abi: ERC20_ABI, functionName: "allowance", args: [q.payer, q.permit2] }),
    ctx.publicClient.verifyTypedData({ address: q.payer, ...q.typedData, signature: q.signature }).catch(() => false),
    ctx.publicClient.getCode({ address: q.proxy }),
  ]);
  const blockNumber = block.number ?? undefined;
  const invalid = (invalidReason: string): Permit2StateVerdict => ({ invalidReason, blockNumber });

  // The proxy's settle() has no return value, so a call to a CODELESS address
  // decodes cleanly and simulation would pass — a no-op reported as success.
  if (proxyCode === undefined || proxyCode === "0x") return invalid(ErrorReason.INVALID_TRANSACTION_STATE);
  // Permit2 semantics: executable while validAfter <= block.timestamp <= deadline
  if (block.timestamp < validAfter) return invalid(q.reasons.notYetValid);
  if (block.timestamp + q.minRemaining > deadline) return invalid(q.reasons.expired);
  if ((nonceBitmap >> (nonce & 0xffn)) & 1n) return invalid(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  if (!signatureValid) return invalid(q.reasons.badSignature);
  // Permit2 pulls via transferFrom — without the one-time approve it can never
  // settle. A distinct reason so buyers learn the fix is on their side.
  if (allowance < q.required) return invalid(ErrorReasonExtra.PERMIT2_ALLOWANCE_REQUIRED);
  if (balance < q.required) return invalid(ErrorReason.INSUFFICIENT_FUNDS);
  return { blockNumber };
}
