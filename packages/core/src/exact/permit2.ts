/**
 * The `exact` scheme's permit2 path — build, verify, settle for tokens
 * WITHOUT EIP-3009 (any plain ERC-20).
 *
 * Same doctrine as the eip3009 path: verification runs cheapest-first
 * (envelope → match → time → nonce → signature → allowance → balance →
 * simulation), independent on-chain reads fire in parallel, time checks use
 * chain time. Unlike eip3009, the signature check has no serial dependency
 * (the domain is Permit2's own), so it rides in the same parallel batch as
 * the reads instead of costing an extra round trip.
 *
 * The one structural difference from eip3009: the payer must have approved
 * the Permit2 contract on the token beforehand (a one-time on-chain tx).
 * A missing approval fails verify with `permit2_allowance_required` — the
 * buyer-side fix, not a facilitator problem.
 */

import { hexToBigInt, type Address } from "viem";
import { ErrorReason } from "../errors.js";
import {
  checkPermit2State,
  parsePermit2Fields,
  permit2Contract,
  permit2InnerSignature,
  permit2PermitArg,
  wellFormedPermit2,
} from "../permit2Common.js";
import {
  checkEnvelope,
  requiredRemainingValidity,
  settleGasLimit,
  settlerAccount,
  type BuildPayloadOptions,
  type ChainContext,
} from "../scheme.js";
import { caip2ChainId, nowSeconds, parseAmount, randomNonce, sameAddress } from "../utils.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "../types.js";
import { X402_PERMIT2_PROXY_ABI } from "./abi.js";
import { buildPermit2TypedData, X402_PERMIT2_PROXY_ADDRESS } from "./permit2Eip712.js";
import { settleAndReconcile } from "./reconcile.js";
import type { ExactPermit2Payload, Permit2Authorization } from "./types.js";

const SCHEME = "exact";

/** Does this exact payload carry a permit2 authorization (vs eip3009)? */
export function isPermit2Payload(payload: unknown): payload is ExactPermit2Payload {
  if (!payload || typeof payload !== "object") return false;
  const auth = (payload as { permit2Authorization?: unknown }).permit2Authorization;
  return typeof auth === "object" && auth !== null;
}

/**
 * ctx/opts → the two contract addresses, defaults applied in ONE place so
 * build, verify, and settle can never disagree on which contracts they target.
 */
function permit2Addresses(src: { permit2Address?: Address; permit2Proxy?: Address }): {
  permit2: Address;
  proxy: Address;
} {
  return { permit2: permit2Contract(src), proxy: src.permit2Proxy ?? X402_PERMIT2_PROXY_ADDRESS };
}

/** Simulate the exact proxy call settlement makes — shared by verify and settle */
function simulateSettle(
  ctx: ChainContext,
  auth: Permit2Authorization,
  signature: `0x${string}`,
  account: Parameters<ChainContext["publicClient"]["simulateContract"]>[0]["account"],
) {
  return ctx.publicClient.simulateContract({
    address: permit2Addresses(ctx).proxy,
    abi: X402_PERMIT2_PROXY_ABI,
    functionName: "settle",
    args: [
      permit2PermitArg(auth),
      auth.from,
      { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
      permit2InnerSignature(signature),
    ],
    account,
    // One ceiling for simulation AND broadcast: a payer whose ERC-1271 account
    // burns gas in isValidSignature fails verify instead of costing the
    // facilitator a block's worth of gas at inclusion.
    gas: settleGasLimit(ctx),
  });
}

/** Verdict plus the chain height it was judged at (settle's reconciliation lower bound) */
export interface VerifiedPermit2 {
  result: VerifyResponse;
  blockNumber?: bigint | undefined;
}

export async function verifyPermit2(
  payload: PaymentPayload<ExactPermit2Payload>,
  req: PaymentRequirements,
  ctx: ChainContext,
  opts: { atSettle?: boolean } = {},
): Promise<VerifiedPermit2> {
  const shaped = wellFormedPermit2(payload);
  if (!shaped) return { result: { isValid: false, invalidReason: ErrorReason.INVALID_PAYLOAD } };
  const { auth, signature } = shaped;
  const payer = auth.from;
  const invalid = (invalidReason: string, blockNumber?: bigint): VerifiedPermit2 => ({
    result: { isValid: false, invalidReason, payer },
    blockNumber,
  });

  // --- envelope (scheme-independent invariants — owned by core, in one place) ---
  const envelope = checkEnvelope(payload, req, ctx, SCHEME);
  if (envelope) return invalid(envelope);

  // --- match: the signed permit must be exactly what the seller demanded ---
  const wantValue = parseAmount(req.amount);
  const fields = parsePermit2Fields(auth);
  if (wantValue === undefined || wantValue === 0n) return invalid(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
  if (!fields) return invalid(ErrorReason.INVALID_PAYLOAD);
  if (fields.amount !== wantValue) return invalid(ErrorReason.EXACT_VALUE_MISMATCH);
  // The signature covers the token — a permit over a different token than the
  // terms' asset would move the wrong funds.
  if (!sameAddress(auth.permitted.token, req.asset)) return invalid(ErrorReason.INVALID_PAYLOAD);
  if (!sameAddress(auth.witness.to, req.payTo)) return invalid(ErrorReason.EXACT_RECIPIENT_MISMATCH);
  // Only the proxy may be the spender: it is what enforces witness.to on-chain.
  // A signature naming any other spender hands that spender free routing.
  const { permit2, proxy } = permit2Addresses(ctx);
  if (!sameAddress(auth.spender, proxy)) return invalid(ErrorReason.INVALID_PAYLOAD);

  // --- on-chain state: proxy code → time → nonce → signature → allowance → balance ---
  const state = await checkPermit2State(ctx, {
    payer,
    asset: req.asset,
    permit2,
    proxy,
    required: fields.amount,
    fields,
    typedData: buildPermit2TypedData({ chainId: ctx.chainId, permit2Address: permit2 }, auth),
    signature,
    minRemaining: requiredRemainingValidity(ctx, !!opts.atSettle),
    reasons: {
      notYetValid: ErrorReason.EXACT_VALID_AFTER,
      expired: ErrorReason.EXACT_VALID_BEFORE,
      badSignature: ErrorReason.EXACT_SIGNATURE,
    },
  });
  if (state.invalidReason) return invalid(state.invalidReason, state.blockNumber);

  // --- simulation: proves the exact call settle will make can actually land
  // (token blacklists/pauses, proxy state) — verify must not be a "passes but
  // never settles" oracle.
  // settle re-verifies state only; it is about to run the real call
  if (!opts.atSettle) {
    try {
      await simulateSettle(ctx, auth, signature, settlerAccount(ctx, auth.witness.to));
    } catch {
      return invalid(ErrorReason.INVALID_TRANSACTION_STATE, state.blockNumber);
    }
  }

  return { result: { isValid: true, payer }, blockNumber: state.blockNumber };
}

export async function settlePermit2(
  payload: PaymentPayload<ExactPermit2Payload>,
  req: PaymentRequirements,
  ctx: ChainContext,
): Promise<SettleResponse> {
  const { permit2Authorization: auth, signature } = payload.payload;
  const payer = auth.from;
  const fail = (errorReason: string): SettleResponse => ({
    success: false,
    errorReason,
    transaction: "",
    network: req.network,
    payer,
  });

  const wallet = ctx.walletClient;
  const account = wallet?.account;
  if (!wallet || !account) return fail(ErrorReason.UNEXPECTED_SETTLE_ERROR);

  // Re-verify immediately before settlement — between verify and settle the
  // balance/allowance can drain or the nonce can be consumed first.
  // Simulation is skipped here because it happens below anyway.
  const check = await verifyPermit2(payload, req, ctx, { atSettle: true });
  if (!check.result.isValid) return fail(check.result.invalidReason ?? ErrorReason.UNEXPECTED_SETTLE_ERROR);

  let request;
  try {
    request = (await simulateSettle(ctx, auth, signature, account)).request;
  } catch {
    return fail(ErrorReason.INVALID_TRANSACTION_STATE);
  }
  return settleAndReconcile(
    ctx,
    wallet,
    request,
    { token: req.asset, from: auth.from, to: auth.witness.to, amount: auth.permitted.amount },
    req.network,
    check.blockNumber,
  );
}

export async function buildPermit2Payload(
  req: PaymentRequirements,
  opts: BuildPayloadOptions,
): Promise<PaymentPayload<ExactPermit2Payload>> {
  const chainId = caip2ChainId(req.network);
  if (chainId === undefined) throw new Error(`not an EVM network: ${req.network}`);

  // Never taken from the wire: a seller-supplied spender could route funds
  // anywhere. Overrides are operator-side options only.
  const { permit2, proxy } = permit2Addresses(opts);
  const now = opts.now ?? nowSeconds();
  const validFor = opts.validForSeconds ?? req.maxTimeoutSeconds;
  const auth: Permit2Authorization = {
    permitted: { token: req.asset, amount: req.amount },
    from: opts.signer.address,
    spender: proxy,
    // Random uint256 — Permit2 unordered nonces, so concurrent payments never
    // block each other (same property as eip3009's random bytes32)
    nonce: hexToBigInt(randomNonce()).toString(),
    deadline: String(now + validFor),
    witness: {
      to: req.payTo,
      // Default: 60s of clock-skew slack, mirroring eip3009. An explicit
      // opts.validAfter pins a future window instead.
      validAfter: String(opts.validAfter ?? now - 60),
    },
  };

  const signature = await opts.signer.signTypedData(
    buildPermit2TypedData({ chainId, permit2Address: permit2 }, auth),
  );

  return {
    x402Version: 2,
    accepted: req,
    payload: { signature, permit2Authorization: auth },
  };
}
