/**
 * Scheme extension point — the kit's single plugin interface.
 *
 * One scheme implements all four faces: buyer (buildPayload), verification
 * (verify), settlement (settle), and payment identity (paymentId). exact is
 * built in; custom schemes register through the same interface. The
 * seller and facilitator presets share the registry, so one registration
 * covers the whole pipeline.
 */

import type { Address, Hex, PublicClient, TypedDataDefinition, WalletClient } from "viem";
import { ErrorReason } from "./errors.js";
import { caip2ChainId, matchesNetwork, parseAmount, sameAddress } from "./utils.js";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "./types.js";

/**
 * Buyer-side signing adapter. viem's LocalAccount / WalletClient satisfy it
 * as-is; a passkey AA wallet plugs in by implementing this interface.
 */
export interface PaymentSigner {
  address: Address;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

/** How scheme implementations touch the chain. RPC wiring is encapsulated here */
export interface ChainContext {
  network: Network;
  chainId: number;
  publicClient: PublicClient;
  /** Needed only for settle. A verify-only context may omit it */
  walletClient?: WalletClient;
  /** Erc6492Settler address — enables first payments from undeployed accounts */
  erc6492Settler?: Address;
  /** Permit2 contract override (exact/permit2). Default: the canonical CREATE2 address */
  permit2Address?: Address;
  /** x402ExactPermit2Proxy override (exact/permit2) — the only spender accepted */
  permit2Proxy?: Address;
  /** x402UptoPermit2Proxy override (upto) — the only spender accepted for a cap authorization */
  uptoPermit2Proxy?: Address;
  /**
   * Max time (ms) to wait for a settlement receipt before giving up. On
   * timeout the tx may STILL land, so the scheme returns `settlement_pending`
   * and the caller must NOT blindly resubmit — the on-chain nonce/period is
   * the real guard. Default 60_000.
   */
  receiptTimeoutMs?: number;
  /**
   * Gas ceiling for a settlement transaction (eip3009 / permit2 paths).
   * Applied to BOTH the verify-time simulation and the broadcast tx, so a
   * payment whose signer is a contract with a gas-burning `isValidSignature`
   * fails verify instead of making the facilitator pay a block's worth of gas
   * for a 1-wei transfer. Default 300_000 — a real settle is ~60–150k.
   */
  maxSettleGas?: number;
  /**
   * Gas ceiling for the ERC-6492 deploy-and-settle path, where `factory` and
   * `factoryCalldata` come straight from the buyer's signature wrapper
   * (attacker-chosen code). Default 1_500_000.
   */
  maxErc6492SettleGas?: number;
  /**
   * Address settlement will be sent FROM, for verify-time simulation when no
   * walletClient is attached (a verify-only facilitator). Simulation must
   * use the same `from` as settle, or a contract signer that branches on
   * tx.origin turns verify into a "passes but never settles" oracle.
   */
  settlerAddress?: Address;
  /**
   * Operator-known token metadata (EIP-712 domain etc.). When present it is
   * trusted over the wire's `extra` — deciding whom to trust belongs to the
   * operating layer.
   */
  assetInfo?(asset: Address): { name: string; version: string } | undefined;
  /**
   * Minimum seconds an authorization must remain valid at VERIFY time. A
   * buyer controls validBefore/deadline; without a margin they can present
   * `validBefore = now + 1`, pass verify, receive the goods, and have settle
   * fail seconds later as expired. Not applied to settle's own re-verify.
   * Default 6 — above the block time of every supported chain.
   */
  minRemainingValiditySeconds?: number;
  /**
   * Which on-chain transactions have already been credited to a payment.
   * Reconciliation after a reverted settle looks for an external transfer
   * that paid the seller anyway; the ledger stops ONE such transfer from
   * being credited to TWO payments of equal amount. Default: a bounded
   * in-memory ledger per publicClient.
   */
  settlementLedger?: SettlementLedger;
}

export interface SettlementLedger {
  has(txHash: Hex): boolean;
  add(txHash: Hex): void;
}

export const DEFAULT_MIN_REMAINING_VALIDITY_SECONDS = 6;

/** Seconds of validity verify demands beyond the current block — zero at settle */
export function requiredRemainingValidity(ctx: ChainContext, atSettle: boolean): bigint {
  return atSettle ? 0n : BigInt(ctx.minRemainingValiditySeconds ?? DEFAULT_MIN_REMAINING_VALIDITY_SECONDS);
}

const DEFAULT_LEDGER_CAPACITY = 10_000;
const defaultLedgers = new WeakMap<PublicClient, SettlementLedger>();

/** Insertion-ordered, bounded — old hashes fall out long after their payments could still be reconciled */
function boundedLedger(): SettlementLedger {
  const seen = new Set<Hex>();
  return {
    has: (h) => seen.has(h.toLowerCase() as Hex),
    add(h) {
      seen.add(h.toLowerCase() as Hex);
      if (seen.size > DEFAULT_LEDGER_CAPACITY) seen.delete(seen.values().next().value as Hex);
    },
  };
}

export function settlementLedger(ctx: ChainContext): SettlementLedger {
  if (ctx.settlementLedger) return ctx.settlementLedger;
  let ledger = defaultLedgers.get(ctx.publicClient);
  if (!ledger) {
    ledger = boundedLedger();
    defaultLedgers.set(ctx.publicClient, ledger);
  }
  return ledger;
}

export const DEFAULT_MAX_SETTLE_GAS = 300_000;
export const DEFAULT_MAX_ERC6492_SETTLE_GAS = 1_500_000;

/** The gas ceiling a settle simulation/broadcast runs under — one reader for every path */
export function settleGasLimit(ctx: ChainContext, path: "standard" | "erc6492" = "standard"): bigint {
  return BigInt(
    path === "erc6492"
      ? (ctx.maxErc6492SettleGas ?? DEFAULT_MAX_ERC6492_SETTLE_GAS)
      : (ctx.maxSettleGas ?? DEFAULT_MAX_SETTLE_GAS),
  );
}

/**
 * The address a settlement simulation must run from: the settling wallet if
 * attached, else the declared settler, else the given fallback. Verify and
 * settle MUST agree on this or verify becomes an oracle (see settlerAddress).
 */
export function settlerAccount(ctx: ChainContext, fallback: Address): Address {
  return configuredSettler(ctx) ?? fallback;
}

/** The address this context settles from, if it knows one (attached wallet, else the declared settler) */
export function configuredSettler(ctx: ChainContext): Address | undefined {
  return ctx.walletClient?.account?.address ?? ctx.settlerAddress;
}

/**
 * Is this ChainContext internally consistent? `network` (CAIP-2), `chainId`
 * (EIP-712 domain), and the client's chain must all name the same chain — a
 * mismatch makes every signature verify against the wrong domain or, worse,
 * settle on the wrong chain (Permit2 and the proxy are CREATE2-same on all
 * chains). Throws with a precise message; call once where the context is built.
 */
export function validateChainContext(ctx: ChainContext): void {
  const fromNetwork = caip2ChainId(ctx.network);
  if (fromNetwork === undefined) throw new Error(`ChainContext.network is not an eip155 CAIP-2 id: ${ctx.network}`);
  if (fromNetwork !== ctx.chainId) {
    throw new Error(`ChainContext mismatch: network ${ctx.network} vs chainId ${ctx.chainId}`);
  }
  for (const [label, client] of [["publicClient", ctx.publicClient], ["walletClient", ctx.walletClient]] as const) {
    const id = client?.chain?.id;
    if (id !== undefined && id !== ctx.chainId) {
      throw new Error(`ChainContext mismatch: ${label}.chain.id ${id} vs chainId ${ctx.chainId}`);
    }
  }
}

export interface BuildPayloadOptions {
  signer: PaymentSigner;
  /** Validity window in seconds. Defaults to requirements.maxTimeoutSeconds */
  validForSeconds?: number;
  /**
   * Reference time (unix seconds). Defaults to wall clock. Verifiers judge by
   * chain time, so pass chain time in environments where the chain clock
   * diverges from the wall clock (forked testnets etc.).
   */
  now?: number;
  /**
   * exact/permit2 only: override the spender proxy the signature authorizes.
   * NEVER wire-controlled — a seller-supplied spender could route funds
   * anywhere. Set it only for private/test deployments you operate.
   */
  permit2Proxy?: Address;
  /** exact/permit2 only: Permit2 contract override (EIP-712 verifying contract) */
  permit2Address?: Address;
  /** upto only: spender proxy override. Same rule as permit2Proxy — never wire-controlled */
  uptoPermit2Proxy?: Address;
}

export interface SchemeHandler<P = unknown> {
  readonly scheme: string;
  /**
   * `requirements.amount` means different things at verify (the signed cap)
   * and settle (the seller's actual charge) — spec scheme_upto.md §5. A
   * facilitator must then NOT key settle idempotency on the amount: one
   * authorization settles once whatever figure is asked for. Schemes whose
   * amount is signed (exact) leave this unset and keep amount in the key, so
   * two payloads sharing a nonce but not an amount stay distinct.
   */
  readonly phaseDependentAmount?: boolean;
  /**
   * Phase-dependent schemes: judge a seller's settle-time amount against the
   * terms (e.g. ≤ the signed cap). Returns the canonical amount to send, or a
   * reason code. Schemes without it have a fixed amount — a requested override
   * is ignored by the seller layer.
   */
  settleAmount?(requested: string, requirements: PaymentRequirements): { amount: string } | { error: string };
  /**
   * Scheme-specific fields a facilitator must advertise per `/supported` kind
   * (e.g. upto's `facilitatorAddress`, which buyers bind into the witness).
   * Called once per configured network at facilitator construction.
   */
  supportedExtra?(settler: Address): Record<string, unknown>;
  /** Networks this scheme works on. CAIP-2 patterns ("eip155:*" or exact values) */
  readonly networks: readonly string[];

  /**
   * When set, buyers must opt in to this scheme explicitly before signing —
   * the string is the reason shown when consent is missing. Declared by the
   * scheme because only the scheme knows whether its terms outlive the
   * request (e.g. a subscription scheme binding future periods).
   */
  readonly requiresConsent?: string;

  /**
   * Replay identity of one payment — becomes the facilitator's idempotency
   * key. exact answers (from, nonce); each scheme must answer for itself.
   */
  paymentId(payload: PaymentPayload<P>, requirements: PaymentRequirements): string;

  /**
   * Are these requirements well-formed for this scheme? Lets sellers fail at
   * paywall construction instead of at the first lost sale (exact: is the
   * EIP-712 domain present in extra?). Optional — absence means "no scheme-
   * specific shape to check".
   *
   * @returns a human-readable problem, or undefined when fine
   */
  validateRequirements?(requirements: PaymentRequirements): string | undefined;

  /** Buyer face — turn 402 requirements into a signed payload. Not a transaction; zero gas */
  buildPayload(
    requirements: PaymentRequirements,
    opts: BuildPayloadOptions,
  ): Promise<PaymentPayload<P>>;

  /** Verification face — never mutates chain state. Free and instant is the contract */
  verify(
    payload: PaymentPayload<P>,
    requirements: PaymentRequirements,
    ctx: ChainContext,
  ): Promise<VerifyResponse>;

  /** Settlement face — re-verify, then submit on-chain. Gas is paid by ctx.walletClient */
  settle(
    payload: PaymentPayload<P>,
    requirements: PaymentRequirements,
    ctx: ChainContext,
  ): Promise<SettleResponse>;
}

/**
 * A handler with its payload type erased — the registry's element type.
 * The single erasure point that lets heterogeneous schemes share one map.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchemeHandler = SchemeHandler<any>;

export type SchemeRegistry = Map<string, AnySchemeHandler>;

export function createSchemeRegistry(handlers: AnySchemeHandler[]): SchemeRegistry {
  return new Map(handlers.map((h) => [h.scheme, h]));
}

/**
 * Do two PaymentRequirements describe the same terms? The one definition of
 * the echo relationship — used by envelope checking, by sellers matching a
 * payload back to their accepts[] entry, and by anything else that must not
 * invent its own weaker comparison.
 */
export function matchesRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  // parseAmount (never throws) so a malformed wire amount is a mismatch, not a
  // 500 — this is called on untrusted seller input in the paywall.
  const amountA = parseAmount(a.amount);
  const amountB = parseAmount(b.amount);
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    amountA !== undefined &&
    amountA === amountB &&
    sameAddress(a.asset, b.asset) &&
    sameAddress(a.payTo, b.payTo)
  );
}

/**
 * Find the accepts[] entry a payload's `accepted` echo corresponds to.
 * undefined means the buyer signed terms the seller never offered — a
 * protocol error the caller should answer with invalid_payment_requirements.
 */
export function selectRequirements(
  accepts: PaymentRequirements[],
  payload: PaymentPayload<unknown>,
): PaymentRequirements | undefined {
  return accepts.find((a) => matchesRequirements(a, payload.accepted));
}

/**
 * Resolve requirements to a capable handler — scheme lookup plus the
 * handler's own network declaration. The single implementation of the routing
 * rule every shell (buyer, seller, facilitator) needs.
 */
export function resolveHandler(
  handlers: readonly AnySchemeHandler[],
  requirements: PaymentRequirements,
): { handler: AnySchemeHandler } | { error: string } {
  const handler = handlers.find((h) => h.scheme === requirements.scheme);
  if (!handler) return { error: ErrorReason.UNSUPPORTED_SCHEME };
  if (!handler.networks.some((p) => matchesNetwork(p, requirements.network))) {
    return { error: ErrorReason.INVALID_NETWORK };
  }
  return { handler };
}

/**
 * Envelope check — scheme-independent invariants, called on the first line of
 * every scheme's verify AND settle. Implemented once so schemes cannot drift
 * apart by re-typing them.
 *
 * `amountEcho: false` is for phase-dependent schemes (upto §5 semantics):
 * the amount is then the scheme's own business, while the terms identity
 * (scheme/network/asset/payTo) must still echo.
 *
 * @returns a failure reason code, or undefined when valid
 */
export function checkEnvelope(
  payload: PaymentPayload<unknown>,
  req: PaymentRequirements,
  ctx: ChainContext,
  scheme: string,
  opts: { amountEcho?: boolean } = {},
): string | undefined {
  if (payload.x402Version !== 2) return ErrorReason.INVALID_X402_VERSION;
  if (req.scheme !== scheme) return ErrorReason.UNSUPPORTED_SCHEME;
  if (req.network !== ctx.network) return ErrorReason.INVALID_NETWORK;

  // `accepted` is an echo of the requirements — if the buyer signed different
  // terms, cut it off here. parseAmount never throws on malformed wire data.
  const a = payload.accepted ?? ({} as PaymentRequirements);
  let amountEcho = true;
  if (opts.amountEcho !== false) {
    const echoed = parseAmount(a.amount);
    amountEcho = echoed !== undefined && echoed === parseAmount(req.amount);
  }
  const echoIntact =
    a.scheme === req.scheme &&
    a.network === req.network &&
    sameAddress(a.asset ?? "", req.asset) &&
    sameAddress(a.payTo ?? "", req.payTo) &&
    amountEcho;
  if (!echoIntact) return ErrorReason.INVALID_PAYMENT_REQUIREMENTS;
  return undefined;
}
