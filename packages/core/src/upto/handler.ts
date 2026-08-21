/**
 * The `upto` scheme — pre-authorize a cap, settle the actual amount, once.
 * Spec: schemes/upto/scheme_upto.md + scheme_upto_evm.md. Permit2 only.
 *
 * Phase-dependent `amount` (spec §5): at VERIFY time `requirements.amount` is
 * the cap and must equal the signed `permitted.amount`; at SETTLE time the
 * seller sends the same payload with `requirements.amount` lowered to the
 * actual charge (≤ cap, may be 0). No new wire field — a standard client or
 * facilitator on the other side interoperates unchanged.
 *
 * Why a separate proxy: exact's x402ExactPermit2Proxy always moves the full
 * permitted amount. x402UptoPermit2Proxy takes `amount` as an argument and
 * additionally requires `msg.sender == witness.facilitator`, so a cap
 * signature can only be drawn by the facilitator the buyer named.
 *
 * The Permit2 invariants (shape, fields, on-chain state) are shared with
 * exact/permit2 via permit2Common; this file owns only what upto adds — the
 * cap semantics, the upto proxy as spender, and the facilitator-bound witness.
 */

import { hexToBigInt, isAddress, type Address } from "viem";
import { ErrorReason, ErrorReasonExtra } from "../errors.js";
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
  configuredSettler,
  requiredRemainingValidity,
  settleGasLimit,
  settlerAccount,
  type BuildPayloadOptions,
  type ChainContext,
  type SchemeHandler,
} from "../scheme.js";
import { caip2ChainId, canonicalAddress, canonicalNonce, nowSeconds, parseAmount, randomNonce, sameAddress } from "../utils.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "../types.js";
import { settleAndReconcile } from "../exact/reconcile.js";
import { X402_UPTO_PERMIT2_PROXY_ABI } from "./abi.js";
import { X402_UPTO_PERMIT2_PROXY_ADDRESS, buildUptoTypedData } from "./eip712.js";
import type { UptoPayload, UptoPermit2Authorization } from "./types.js";

const SCHEME = "upto";

/** Does this payload carry an upto (facilitator-bound witness) authorization? */
export function isUptoPayload(payload: unknown): payload is UptoPayload {
  if (!payload || typeof payload !== "object") return false;
  const auth = (payload as { permit2Authorization?: { witness?: unknown } }).permit2Authorization;
  const witness = auth && typeof auth === "object" ? auth.witness : undefined;
  return typeof witness === "object" && witness !== null && "facilitator" in witness;
}

function uptoProxy(src: { uptoPermit2Proxy?: Address }): Address {
  return src.uptoPermit2Proxy ?? X402_UPTO_PERMIT2_PROXY_ADDRESS;
}

/** The call settlement makes, simulated with a given amount — verify uses the cap, settle the actual */
function simulateSettle(
  ctx: ChainContext,
  auth: UptoPermit2Authorization,
  amount: bigint,
  signature: `0x${string}`,
  account: Parameters<ChainContext["publicClient"]["simulateContract"]>[0]["account"],
) {
  return ctx.publicClient.simulateContract({
    address: uptoProxy(ctx),
    abi: X402_UPTO_PERMIT2_PROXY_ABI,
    functionName: "settle",
    args: [
      permit2PermitArg(auth),
      amount,
      auth.from,
      { to: auth.witness.to, facilitator: auth.witness.facilitator, validAfter: BigInt(auth.witness.validAfter) },
      permit2InnerSignature(signature),
    ],
    account,
    gas: settleGasLimit(ctx),
  });
}

interface VerifiedCap {
  result: VerifyResponse;
  blockNumber?: bigint | undefined;
  /** The signed cap, once the payload proved well-formed */
  cap?: bigint;
}

/**
 * Verify against the CAP: `req.amount` must equal the signed permitted.amount.
 * Settlement calls this with the cap restored before applying its own amount.
 */
async function verifyCap(
  payload: PaymentPayload<UptoPayload>,
  req: PaymentRequirements,
  ctx: ChainContext,
  opts: { atSettle?: boolean } = {},
): Promise<VerifiedCap> {
  const shaped = wellFormedPermit2(payload);
  if (!shaped) return { result: { isValid: false, invalidReason: ErrorReason.INVALID_PAYLOAD } };
  const { auth, signature } = shaped;
  const payer = auth.from;
  const invalid = (invalidReason: string, blockNumber?: bigint): VerifiedCap => ({
    result: { isValid: false, invalidReason, payer },
    blockNumber,
  });

  const envelope = checkEnvelope(payload, req, ctx, SCHEME);
  if (envelope) return invalid(envelope);

  const cap = parseAmount(req.amount);
  const fields = parsePermit2Fields(auth);
  if (cap === undefined || cap === 0n) return invalid(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
  if (!fields) return invalid(ErrorReason.INVALID_PAYLOAD);
  if (fields.amount !== cap) return invalid(ErrorReasonExtra.PERMIT2_AMOUNT_MISMATCH);
  if (!sameAddress(auth.permitted.token, req.asset)) return invalid(ErrorReason.INVALID_PAYLOAD);
  if (!isAddress(auth.witness.to ?? "") || !sameAddress(auth.witness.to, req.payTo)) {
    return invalid(ErrorReasonExtra.PERMIT2_RECIPIENT_MISMATCH);
  }
  const permit2 = permit2Contract(ctx);
  const proxy = uptoProxy(ctx);
  if (!isAddress(auth.spender ?? "") || !sameAddress(auth.spender, proxy)) return invalid(ErrorReasonExtra.PERMIT2_SPENDER);
  // The proxy enforces msg.sender == witness.facilitator, so the signature is
  // only executable by the address we settle from. Judge it here so a cap
  // bound to some other facilitator fails verify, not settle.
  const settler = configuredSettler(ctx);
  if (!settler || !isAddress(auth.witness.facilitator ?? "") || !sameAddress(auth.witness.facilitator, settler)) {
    return invalid(ErrorReasonExtra.UPTO_FACILITATOR_MISMATCH);
  }

  // Worst case is the full cap — that is what the buyer must be able to cover
  const state = await checkPermit2State(ctx, {
    payer,
    asset: req.asset,
    permit2,
    proxy,
    required: cap,
    fields,
    typedData: buildUptoTypedData({ chainId: ctx.chainId, permit2Address: permit2 }, auth),
    signature,
    minRemaining: requiredRemainingValidity(ctx, !!opts.atSettle),
    reasons: {
      notYetValid: ErrorReasonExtra.PERMIT2_NOT_YET_VALID,
      expired: ErrorReasonExtra.PERMIT2_DEADLINE_EXPIRED,
      badSignature: ErrorReasonExtra.PERMIT2_SIGNATURE,
    },
  });
  if (state.invalidReason) return invalid(state.invalidReason, state.blockNumber);

  // settle re-verifies state only; it is about to run the real call
  if (!opts.atSettle) {
    try {
      await simulateSettle(ctx, auth, cap, signature, settlerAccount(ctx, auth.witness.to));
    } catch {
      return invalid(ErrorReason.INVALID_TRANSACTION_STATE, state.blockNumber);
    }
  }
  return { result: { isValid: true, payer }, blockNumber: state.blockNumber, cap };
}

/** Judge a settle-time amount against the cap — the one rule the seller layer and settle share */
function settleAmount(requested: string, req: PaymentRequirements): { amount: string } | { error: string } {
  const actual = parseAmount(requested);
  const cap = parseAmount(req.amount);
  if (actual === undefined || cap === undefined) return { error: ErrorReason.INVALID_PAYMENT_REQUIREMENTS };
  if (actual > cap) return { error: ErrorReason.UPTO_SETTLEMENT_EXCEEDS_AMOUNT };
  return { amount: actual.toString() };
}

async function settle(
  payload: PaymentPayload<UptoPayload>,
  req: PaymentRequirements,
  ctx: ChainContext,
): Promise<SettleResponse> {
  const auth = payload.payload?.permit2Authorization;
  const fail = (errorReason: string): SettleResponse => ({
    success: false,
    errorReason,
    transaction: "",
    network: req.network,
    ...(auth?.from ? { payer: auth.from } : {}),
  });

  const wallet = ctx.walletClient;
  const account = wallet?.account;
  if (!wallet || !account) return fail(ErrorReason.UNEXPECTED_SETTLE_ERROR);

  // Re-verify against the cap (the signed figure) — every check in verifyCap
  // is about the authorization, which did not change. Then judge the actual.
  const check = await verifyCap(payload, { ...req, amount: auth?.permitted?.amount ?? "" }, ctx, { atSettle: true });
  if (!check.result.isValid || check.cap === undefined) return fail(check.result.invalidReason ?? ErrorReason.UNEXPECTED_SETTLE_ERROR);
  const judged = settleAmount(req.amount, { ...req, amount: check.cap.toString() });
  if ("error" in judged) return fail(judged.error);
  const actual = BigInt(judged.amount);

  // Spec: a $0 settlement is a success with no transaction. The proxy would
  // revert on amount 0 (InvalidAmount), so it is decided here, off-chain.
  if (actual === 0n) return { success: true, transaction: "", network: req.network, payer: auth.from, amount: "0" };

  let request;
  try {
    request = (await simulateSettle(ctx, auth, actual, payload.payload.signature, account)).request;
  } catch {
    return fail(ErrorReason.INVALID_TRANSACTION_STATE);
  }
  return settleAndReconcile(
    ctx,
    wallet,
    request,
    { token: req.asset, from: auth.from, to: auth.witness.to, amount: judged.amount },
    req.network,
    check.blockNumber,
  );
}

function facilitatorOf(req: PaymentRequirements): Address | undefined {
  const f = req.extra?.["facilitatorAddress"];
  return typeof f === "string" && isAddress(f) ? f : undefined;
}

function validateRequirements(req: PaymentRequirements): string | undefined {
  if (caip2ChainId(req.network) === undefined) return `upto needs an EVM (eip155) network, got "${req.network}"`;
  const method = req.extra?.assetTransferMethod;
  if (method !== undefined && method !== "permit2") {
    return `upto settles through Permit2 only — assetTransferMethod "${String(method)}" is not supported`;
  }
  if (!facilitatorOf(req)) {
    return "upto terms need extra.facilitatorAddress (the facilitator's settlement address, from its /supported) — the buyer binds it into the signature";
  }
  return undefined;
}

async function buildPayload(req: PaymentRequirements, opts: BuildPayloadOptions): Promise<PaymentPayload<UptoPayload>> {
  const bad = validateRequirements(req);
  if (bad) throw new Error(bad);
  const chainId = caip2ChainId(req.network)!;
  const facilitator = facilitatorOf(req)!;
  // Never taken from the wire: a seller-supplied spender could route funds anywhere
  const permit2 = permit2Contract(opts);
  const now = opts.now ?? nowSeconds();
  const validFor = opts.validForSeconds ?? req.maxTimeoutSeconds;
  const auth: UptoPermit2Authorization = {
    permitted: { token: req.asset, amount: req.amount },
    from: opts.signer.address,
    spender: uptoProxy(opts),
    nonce: hexToBigInt(randomNonce()).toString(),
    deadline: String(now + validFor),
    witness: { to: req.payTo, facilitator, validAfter: String(opts.validAfter ?? now - 60) },
  };
  const signature = await opts.signer.signTypedData(buildUptoTypedData({ chainId, permit2Address: permit2 }, auth));
  return { x402Version: 2, accepted: req, payload: { signature, permit2Authorization: auth } };
}

export const uptoScheme: SchemeHandler<UptoPayload> = {
  scheme: SCHEME,
  networks: ["eip155:*"],
  phaseDependentAmount: true,
  supportedExtra: (settler) => ({ facilitatorAddress: settler }),
  settleAmount,
  // Same identity rule as exact: the signed (from, nonce) — single-use on-chain
  // whatever amount is finally drawn. Never throws.
  paymentId: (payload) => {
    const auth = (payload.payload as Partial<UptoPayload> | undefined)?.permit2Authorization;
    return `${canonicalAddress(auth?.from)}:${canonicalNonce(auth?.nonce)}`;
  },
  validateRequirements,
  buildPayload,
  verify: async (payload, req, ctx) => (await verifyCap(payload, req, ctx)).result,
  settle,
};
