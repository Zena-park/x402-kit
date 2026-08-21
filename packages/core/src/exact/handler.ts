/**
 * The `exact` scheme — build, verify, settle.
 *
 * Two asset transfer methods share the one scheme, per scheme_exact_evm.md:
 * eip3009 (this file — tokens with transferWithAuthorization) and permit2
 * (permit2.ts — any plain ERC-20, via the x402ExactPermit2Proxy). The
 * requirements' `extra.assetTransferMethod` declares the seller's choice;
 * when unspecified, eip3009 is preferred and permit2 is the fallback.
 *
 * Verification runs cheapest-first, per core doctrine (docs: core-design §5):
 *   envelope → match → time → nonce → signature → balance → simulation
 * The three independent on-chain reads (block time, nonce, balance) are fired
 * in parallel; only the judgement order follows the sequence above.
 *
 * Time checks use **chain time**, not the wall clock — the contract judges by
 * block.timestamp, so a mismatch makes verify pass and settle fail (or the
 * reverse).
 */

import { isAddress, isHex, type Address, type Hex } from "viem";
import { ErrorReason, ErrorReasonExtra } from "../errors.js";
import { isErc6492Signature, parseErc6492Signature, type Erc6492Signature } from "../erc6492.js";
import {
  checkEnvelope,
  requiredRemainingValidity,
  settleGasLimit,
  settlerAccount,
  type BuildPayloadOptions,
  type ChainContext,
  type SchemeHandler,
} from "../scheme.js";
import { caip2ChainId, canonicalAddress, canonicalNonce, hasCode, nowSeconds, parseAmount, randomNonce, sameAddress } from "../utils.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "../types.js";
import { EIP3009_TOKEN_ABI, ERC6492_SETTLER_ABI } from "./abi.js";
import { buildTransferTypedData } from "./eip712.js";
import { resolveDomain } from "../domain.js";
import { buildPermit2Payload, isPermit2Payload, settlePermit2, verifyPermit2 } from "./permit2.js";
import { settleAndReconcile } from "./reconcile.js";
import type { AnyExactPayload, Eip3009Authorization, ExactPayload, ExactPermit2Payload } from "./types.js";

const SCHEME = "exact";

/** The (value, validAfter, validBefore, nonce) tail shared by the transferWithAuthorization family */
function authTail(auth: Eip3009Authorization) {
  return [BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce] as const;
}

/**
 * Shape gate shared by verify AND settle: the wire schema only guarantees
 * payload is an object, so an eip3009 authorization can be absent or
 * malformed. Returns the authorization + signature only when `from` is a real
 * address and the signature is hex — nothing downstream dereferences a raw
 * field before this passes (it would throw out as a 500 instead of a reason).
 */
function wellFormed(
  payload: PaymentPayload<ExactPayload>,
): { auth: Eip3009Authorization; signature: Hex } | undefined {
  const auth = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!auth || typeof auth !== "object" || !isAddress(auth.from ?? "") || !isHex(signature)) return undefined;
  return { auth, signature };
}

/**
 * The exact call settlement makes, simulated — ONE place owns the `from`
 * account and the gas ceiling for both the verify-time check and the
 * settle-time request, so the two can never disagree (a contract signer that
 * branches on tx.origin / gasleft() would otherwise pass verify and fail
 * settle — an oracle for deliver-on-verify sellers).
 *
 * @returns the simulation, or undefined when an undeployed ERC-6492 account
 *   cannot be settled here (no settler configured / incomplete wrapper)
 */
async function simulateEip3009(
  ctx: ChainContext,
  req: PaymentRequirements,
  auth: Eip3009Authorization,
  sig: Erc6492Signature,
  deployed: boolean,
  account: Address,
) {
  if (!sig.wrapped || deployed) {
    // Normal path — an EOA, or an already-deployed smart account (even if
    // wrapped, only the inner signature is used)
    return ctx.publicClient.simulateContract({
      address: req.asset,
      abi: EIP3009_TOKEN_ABI,
      functionName: "transferWithAuthorization",
      args: [auth.from, auth.to, ...authTail(auth), sig.innerSignature],
      account,
      gas: settleGasLimit(ctx),
    });
  }
  if (!ctx.erc6492Settler || !sig.factory || !sig.factoryCalldata) return undefined;
  // ERC-6492 path — deploy and settle in one transaction. factory/calldata are
  // attacker-chosen code, hence the separate (larger, but bounded) ceiling.
  return ctx.publicClient.simulateContract({
    address: ctx.erc6492Settler,
    abi: ERC6492_SETTLER_ABI,
    functionName: "deployAndSettle",
    args: [auth.from, sig.factory, sig.factoryCalldata, req.asset, auth.to, ...authTail(auth), sig.innerSignature],
    account,
    gas: settleGasLimit(ctx, "erc6492"),
  });
}

interface Verified {
  result: VerifyResponse;
  /** Chain height the reads were judged at — settle's reconciliation lower bound */
  blockNumber?: bigint | undefined;
}

async function verifyInternal(
  payload: PaymentPayload<ExactPayload>,
  req: PaymentRequirements,
  ctx: ChainContext,
  opts: { atSettle?: boolean } = {},
): Promise<Verified> {
  const shaped = wellFormed(payload);
  if (!shaped) return { result: { isValid: false, invalidReason: ErrorReason.INVALID_PAYLOAD } };
  const { auth, signature } = shaped;
  const payer = auth.from;
  const invalid = (invalidReason: string): Verified => ({ result: { isValid: false, invalidReason, payer } });
  // nonce is a signed bytes32; time bounds are decimal strings. Guard both
  // before BigInt()/readContract touches them.
  if (!isHex(auth.nonce) || auth.nonce.length !== 66) return invalid(ErrorReason.INVALID_PAYLOAD);
  if (parseAmount(auth.validAfter) === undefined || parseAmount(auth.validBefore) === undefined) {
    return invalid(ErrorReason.INVALID_PAYLOAD);
  }

  // --- envelope (scheme-independent invariants — owned by core, in one place) ---
  const envelope = checkEnvelope(payload, req, ctx, SCHEME);
  if (envelope) return invalid(envelope);

  // --- match: passing a signature that differs from what the seller demanded hurts the seller ---
  // parseAmount rejects hex/negative/oversized so "-1" can't bypass the balance
  // check and "0x10" can't alias "16"; a zero-value settle is refused so the
  // facilitator can't be made to burn gas on a self-transfer of nothing.
  const wantValue = parseAmount(req.amount);
  const gotValue = parseAmount(auth.value);
  if (wantValue === undefined || gotValue === undefined) return invalid(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
  if (wantValue === 0n) return invalid(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
  if (gotValue !== wantValue) return invalid(ErrorReason.EXACT_VALUE_MISMATCH);
  if (!sameAddress(auth.to, req.payTo)) return invalid(ErrorReason.EXACT_RECIPIENT_MISMATCH);

  const domain = resolveDomain(req, ctx);
  if (!domain) return invalid(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);

  // --- independent on-chain calls — fire in parallel, judge cheapest-first.
  // The signature check depends only on domain + payload (no serial need),
  // and deployment only matters for a wrapped (ERC-6492) signature.
  // verifyTypedData handles EOA (ECDSA), ERC-1271 (smart accounts), and
  // ERC-6492 (undeployed) alike. Passkey wallets sign with P-256, which
  // ecrecover can never verify — this path is what makes them work.
  const sig = parseErc6492Signature(signature);
  const [block, nonceUsed, balance, signatureValid, deployed] = await Promise.all([
    ctx.publicClient.getBlock({ blockTag: "latest" }),
    ctx.publicClient.readContract({
      address: req.asset,
      abi: EIP3009_TOKEN_ABI,
      functionName: "authorizationState",
      args: [payer, auth.nonce],
    }),
    ctx.publicClient.readContract({
      address: req.asset,
      abi: EIP3009_TOKEN_ABI,
      functionName: "balanceOf",
      args: [payer],
    }),
    ctx.publicClient
      .verifyTypedData({ address: payer, ...buildTransferTypedData(domain, auth), signature })
      .catch(() => false),
    sig.wrapped ? hasCode(ctx.publicClient, auth.from) : Promise.resolve(true),
  ]);
  const blockNumber = block.number ?? undefined;
  const invalidAt = (reason: string): Verified => ({ ...invalid(reason), blockNumber });

  if (block.timestamp <= BigInt(auth.validAfter)) return invalidAt(ErrorReason.EXACT_VALID_AFTER);
  // Contract semantics are strict (<), plus verify's settle-window margin
  if (block.timestamp + requiredRemainingValidity(ctx, !!opts.atSettle) >= BigInt(auth.validBefore)) {
    return invalidAt(ErrorReason.EXACT_VALID_BEFORE);
  }
  if (nonceUsed) return invalidAt(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  if (!signatureValid) return invalidAt(ErrorReason.EXACT_SIGNATURE);
  if (balance < gotValue) return invalidAt(ErrorReason.INSUFFICIENT_FUNDS);

  // --- simulation: token-level rules (blacklist, pause) only surface on the
  // real path, AND it proves the payment can actually settle. Skipping it for
  // a wrapped signature turned verify into a "passes but never settles" oracle
  // (free goods for async/none sellers), so we simulate the exact call settle
  // will make instead of trusting the deployless signature check alone.
  // settle re-verifies state only; it is about to run the real call
  if (!opts.atSettle) {
    try {
      const sim = await simulateEip3009(ctx, req, auth, sig, deployed, settlerAccount(ctx, auth.to));
      // undeployed 6492 account but no settler to deploy it → unsettleable
      if (!sim) return invalidAt(ErrorReason.INVALID_TRANSACTION_STATE);
    } catch {
      return invalidAt(ErrorReason.INVALID_TRANSACTION_STATE);
    }
  }

  return { result: { isValid: true, payer }, blockNumber };
}

async function settle(
  payload: PaymentPayload<ExactPayload>,
  req: PaymentRequirements,
  ctx: ChainContext,
): Promise<SettleResponse> {
  const shaped = wellFormed(payload);
  if (!shaped) return { success: false, errorReason: ErrorReason.INVALID_PAYLOAD, transaction: "", network: req.network };
  const { auth, signature } = shaped;
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
  // balance can drain or the nonce can be consumed first. This is exactly
  // where "authorized but capture failed" happens in offline payments.
  // Simulation is skipped here because it happens below anyway.
  const check = await verifyInternal(payload, req, ctx, { atSettle: true });
  if (!check.result.isValid) return fail(check.result.invalidReason ?? ErrorReason.UNEXPECTED_SETTLE_ERROR);

  const sig = parseErc6492Signature(signature);
  const deployed = sig.wrapped ? await hasCode(ctx.publicClient, auth.from) : true;
  let request;
  try {
    const sim = await simulateEip3009(ctx, req, auth, sig, deployed, account.address);
    // A missing settler is a configuration gap, distinct from a failing simulation.
    if (!sim) return fail(ErrorReason.UNEXPECTED_SETTLE_ERROR);
    request = sim.request;
  } catch {
    return fail(ErrorReason.INVALID_TRANSACTION_STATE);
  }
  return settleAndReconcile(
    ctx,
    wallet,
    request,
    { token: req.asset, from: auth.from, to: auth.to, amount: auth.value, eip3009Nonce: auth.nonce },
    req.network,
    check.blockNumber,
  );
}

/**
 * The one place the supported assetTransferMethod set is judged.
 * @returns a human-readable problem, or undefined when the method is usable
 */
function unsupportedMethod(req: PaymentRequirements): string | undefined {
  const method = req.extra?.assetTransferMethod;
  if (method === undefined || method === "eip3009" || method === "permit2") return undefined;
  return `assetTransferMethod "${String(method)}" is not supported (eip3009 | permit2)`;
}

/** Requirements shape this scheme needs — without the domain, buyers cannot sign */
function validateRequirements(req: PaymentRequirements): string | undefined {
  if (caip2ChainId(req.network) === undefined) {
    return `exact needs an EVM (eip155) network, got "${req.network}"`;
  }
  const bad = unsupportedMethod(req);
  if (bad) return bad;
  // permit2 signs under Permit2's own domain — no token metadata needed
  if (req.extra?.assetTransferMethod === "permit2") return undefined;
  if (!req.extra?.name || !req.extra?.version) {
    return `terms for asset ${req.asset} lack extra.name/extra.version (EIP-712 domain) — buyers cannot sign without it (non-EIP-3009 tokens: set assetTransferMethod "permit2")`;
  }
  return undefined;
}

/**
 * Method gate shared by verify and settle: does the payload's transfer method
 * contradict what the terms declare? Unspecified terms accept either method
 * (spec: prefer eip3009, then permit2); specified terms are strict — the
 * seller judged risk for THAT method. On failure, carries the best-effort
 * payer for the error response.
 */
function methodGuard(
  payload: PaymentPayload<AnyExactPayload>,
  req: PaymentRequirements,
): { reason: string; payer?: Address } | undefined {
  const method = req.extra?.assetTransferMethod;
  const isP2 = isPermit2Payload(payload.payload);
  let reason: string | undefined;
  if (unsupportedMethod(req)) {
    reason = ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
  } else if ((method === "permit2" && !isP2) || (method === "eip3009" && isP2)) {
    reason = ErrorReason.INVALID_PAYLOAD;
  }
  if (!reason) return undefined;
  const p = payload.payload as Partial<ExactPayload & ExactPermit2Payload> | undefined;
  const payer = p?.permit2Authorization?.from ?? p?.authorization?.from;
  return { reason, ...(payer ? { payer } : {}) };
}

/**
 * The chain-time window in which an exact payload can settle — inclusive
 * bounds, derived from the payload per its transfer method's own semantics
 * (eip3009 bounds are strict, permit2's are inclusive). The single reader for
 * anything that reasons about "when is this payment due" (schedules etc.).
 */
export function exactPaymentWindow(
  payload: PaymentPayload<AnyExactPayload>,
): { notBefore: number; notAfter: number } {
  if (isPermit2Payload(payload.payload)) {
    const auth = payload.payload.permit2Authorization;
    return { notBefore: Number(auth.witness.validAfter), notAfter: Number(auth.deadline) };
  }
  const auth = payload.payload.authorization;
  return { notBefore: Number(auth.validAfter) + 1, notAfter: Number(auth.validBefore) - 1 };
}

async function buildPayload(
  req: PaymentRequirements,
  opts: BuildPayloadOptions,
): Promise<PaymentPayload<AnyExactPayload>> {
  const bad = unsupportedMethod(req);
  if (bad) throw new Error(bad);
  if (req.extra?.assetTransferMethod === "permit2") return buildPermit2Payload(req, opts);

  // The scheme owns the CAIP-2 → chainId mapping; callers stay chain-agnostic
  const chainId = caip2ChainId(req.network);
  if (chainId === undefined) throw new Error(`not an EVM network: ${req.network}`);
  const domain = resolveDomain(req, { chainId });
  if (!domain) {
    // Unspecified method prefers eip3009 then permit2 (scheme_exact_evm.md) —
    // a domainless plain ERC-20 falls through instead of failing.
    if (req.extra?.assetTransferMethod === undefined) return buildPermit2Payload(req, opts);
    throw new Error("requirements.extra lacks the EIP-712 domain (name/version) — cannot build a signature");
  }

  const now = opts.now ?? nowSeconds();
  const validFor = opts.validForSeconds ?? req.maxTimeoutSeconds;
  const auth: Eip3009Authorization = {
    from: opts.signer.address,
    to: req.payTo,
    value: req.amount,
    // Default: 60s of clock-skew slack — validAfter is a strict "after", so it
    // must sit in the past for the authorization to be valid immediately.
    // An explicit opts.validAfter pins a future window instead.
    validAfter: String(opts.validAfter ?? now - 60),
    validBefore: String(now + validFor),
    nonce: randomNonce(),
  };

  const signature = await opts.signer.signTypedData(buildTransferTypedData(domain, auth));

  return {
    x402Version: 2,
    accepted: req,
    payload: { signature, authorization: auth },
  };
}

export const exactScheme: SchemeHandler<AnyExactPayload> = {
  scheme: SCHEME,
  networks: ["eip155:*"],
  // Replay identity is the SIGNED on-chain nonce, never anything off the wire.
  // (from, nonce) is single-use on-chain, so it is the honest dedup key: two
  // requests with the same signature collapse to one settlement, while a fresh
  // signature is genuinely a new payment. A buyer-supplied identifier is NOT
  // used — it is unsigned, so trusting it would let one payment be replayed as
  // "already settled" for many deliveries (paid once, goods N times).
  // Must never throw — the facilitator derives its idempotency key from this
  // BEFORE verify runs, so a malformed payload has to yield a (useless) key
  // rather than a 500. Malformed inputs collapse to ":" and are all rejected
  // by the settle path's verify anyway.
  // Canonicalized: the same on-chain (from, nonce) must yield ONE id no matter
  // how the wire spells it (checksum vs lowercase address, hex nonce casing,
  // decimal vs hex permit2 nonce) — otherwise N casing variants of one payment
  // become N idempotency keys and N-1 reverted broadcasts.
  // The transfer method is part of the id: an EIP-3009 bytes32 nonce and a
  // Permit2 uint256 nonce live in different on-chain nonce spaces, so the
  // same number is two different payments, never one.
  paymentId: (payload) => {
    const p = payload.payload as Partial<ExactPayload & ExactPermit2Payload> | undefined;
    const method = p?.permit2Authorization ? "permit2" : "eip3009";
    const auth = p?.permit2Authorization ?? p?.authorization;
    return `${method}:${canonicalAddress(auth?.from)}:${canonicalNonce(auth?.nonce)}`;
  },
  validateRequirements,
  buildPayload,
  verify: async (payload, req, ctx) => {
    const guard = methodGuard(payload, req);
    if (guard) {
      return { isValid: false, invalidReason: guard.reason, ...(guard.payer ? { payer: guard.payer } : {}) };
    }
    return isPermit2Payload(payload.payload)
      ? (await verifyPermit2(payload as PaymentPayload<ExactPermit2Payload>, req, ctx)).result
      : (await verifyInternal(payload as PaymentPayload<ExactPayload>, req, ctx)).result;
  },
  settle: async (payload, req, ctx) => {
    const guard = methodGuard(payload, req);
    if (guard) {
      return {
        success: false,
        errorReason: guard.reason,
        transaction: "",
        network: req.network,
        ...(guard.payer ? { payer: guard.payer } : {}),
      };
    }
    return isPermit2Payload(payload.payload)
      ? settlePermit2(payload as PaymentPayload<ExactPermit2Payload>, req, ctx)
      : settle(payload as PaymentPayload<ExactPayload>, req, ctx);
  },
};
