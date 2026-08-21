/**
 * Buyer-side fetch wrapper — catch a 402, sign, retry once.
 *
 * The safety pin is `maxAmount`: terms above the cap are never signed, no
 * matter what the server demands. That is the whole point for agents. Policy
 * refusals never throw — the original 402 is returned untouched so the caller
 * (or the agent's own loop) can decide; `onSkipped` reports why.
 */

import type { Address } from "viem";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequiredSafe,
  decodeSettleResponseSafe,
  encodePaymentPayload,
  exactScheme,
  matchesNetwork,
  nowSeconds,
  parseAmount,
  resolveHandler,
  sameAddress,
  type AnySchemeHandler,
  type PaymentRequirements,
  type PaymentSigner,
  type SettleResponse,
} from "@x402.kit/core";
import { DEFAULT_BUYER_SCHEMES, signPayment } from "./signPayment.js";

export interface WrapFetchOptions {
  signer: PaymentSigner;
  /**
   * Hard cap in atomic units — the wrapper never signs terms above it.
   * Required on purpose: an agent without a spending cap is an incident.
   */
  maxAmount: string;
  /**
   * Cumulative cap across EVERY payment this wrapper (or axios instance)
   * signs, in atomic units of the allowlisted asset(s). `maxAmount` bounds a
   * single payment; a seller that answers 402 to every request — or an agent
   * loop that keeps calling — is bounded only by this. Optional, but an
   * unattended agent should set it.
   */
  maxTotalAmount?: string;
  /**
   * Tokens this buyer will pay in. REQUIRED unless `allowAnyAsset` is set —
   * `maxAmount` is a bare atomic-unit number with no notion of which token
   * or how many decimals, so without an asset allowlist a hostile 402 can
   * name an expensive token (e.g. WBTC) at the same integer and get a far
   * more valuable signature than intended.
   *
   * Prefer chain-scoped entries, `"eip155:8453/erc20:0x8335…"` (CAIP-19): a
   * bare address matches that address on ANY network the 402 names, which
   * is only safe together with `networks`.
   */
  assets?: string[];
  /**
   * Opt in to signing ANY token that fits `maxAmount`. Off by default — only
   * set this when the caller genuinely accepts every asset a 402 might name
   * and understands `maxAmount` is then per-token-atomic, not per-value.
   */
  allowAnyAsset?: boolean;
  /** Restrict to these CAIP-2 networks/patterns. Default: any network a scheme supports */
  networks?: string[];
  /**
   * Schemes this buyer can pay with. Default: [exactScheme, uptoScheme].
   * For upto the terms' amount is a CAP — `maxAmount` bounds the cap (the
   * worst case), and the cumulative budget is trued up to the actual charge
   * once the seller's PAYMENT-RESPONSE reports it.
   */
  schemes?: AnySchemeHandler[];
  /**
   * Scheme names to opt in to, for schemes that declare requiresConsent
   * (their terms outlive the single request). Default: none consented.
   */
  consentTo?: string[];
  /**
   * Upper bound (seconds) on how long a signed authorization stays valid.
   * The server proposes maxTimeoutSeconds; a hostile one proposes a decade,
   * turning your signature into a long-lived bearer instrument. Default 300s.
   */
  maxValiditySeconds?: number;
  /** Called when a 402 was seen but no accepts[] entry was acceptable */
  onSkipped?(reason: string, accepts: PaymentRequirements[]): void;
  /** Called after a paid retry succeeds (response.ok), with the settlement when the server sent one */
  onPaid?(requirements: PaymentRequirements, settlement?: SettleResponse): void;
  /**
   * Time source (unix seconds) for authorization validity. Defaults to the
   * wall clock — override when the verifier's chain clock diverges from it
   * (forked testnets, kiosks trusting server time).
   */
  clock?(): number | Promise<number>;
  /**
   * exact/permit2 only: spender proxy override for private/test deployments.
   * Deliberately an option and never read from the 402 — a seller-supplied
   * spender could route funds anywhere.
   */
  permit2Proxy?: Address;
  /** exact/permit2 only: Permit2 contract override for private/test deployments */
  permit2Address?: Address;
  /** upto only: spender proxy override. Same rule as permit2Proxy — never wire-controlled */
  uptoPermit2Proxy?: Address;
}

interface SelectionPolicy {
  cap: bigint;
  assets?: string[] | undefined;
  networks?: string[] | undefined;
  /** Scheme names the buyer consented to (for handlers declaring requiresConsent) */
  consented: ReadonlySet<string>;
}

/**
 * Pick the first affordable, payable entry. An over-cap or unconsented entry
 * is skipped, not fatal — a multi-term 402 may hold an acceptable option
 * further down. Whether a scheme needs consent is the scheme's own
 * declaration (SchemeHandler.requiresConsent), not this function's knowledge.
 */
function select(
  accepts: PaymentRequirements[],
  handlers: AnySchemeHandler[],
  policy: SelectionPolicy,
): PaymentRequirements | string {
  const reasons: string[] = [];
  for (const requirements of accepts) {
    const resolved = resolveHandler(handlers, requirements);
    if ("error" in resolved) continue;
    // Terms the scheme itself cannot sign (e.g. upto without a facilitator
    // address) are skipped with the scheme's reason — never a throw out of fetch
    const malformed = resolved.handler.validateRequirements?.(requirements);
    if (malformed) {
      reasons.push(malformed);
      continue;
    }
    if (policy.networks && !policy.networks.some((p) => matchesNetwork(p, requirements.network))) continue;
    if (policy.assets && !assetAllowed(policy.assets, requirements)) continue;
    const amount = parseAmount(requirements.amount);
    if (amount === undefined) continue; // malformed amount — not signable
    if (amount > policy.cap) {
      reasons.push(`amount ${requirements.amount} exceeds maxAmount ${policy.cap}`);
      continue;
    }
    if (resolved.handler.requiresConsent && !policy.consented.has(resolved.handler.scheme)) {
      reasons.push(`${resolved.handler.scheme}: ${resolved.handler.requiresConsent}`);
      continue;
    }
    // Note: an over-long maxTimeoutSeconds is not rejected — it is clamped to
    // maxValiditySeconds when the payload is signed (see preparePayment).
    return requirements;
  }
  return reasons[0] ?? "no accepts[] entry matches this buyer's schemes/networks/assets";
}

/**
 * One allowlist entry against the terms' (network, asset). An entry is either
 * a bare token address (any network) or CAIP-19 `<caip2>/erc20:<address>`,
 * where the network part may be a pattern (`eip155:*`).
 */
export function assetAllowed(entries: readonly string[], terms: Pick<PaymentRequirements, "network" | "asset">): boolean {
  return entries.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return sameAddress(entry, terms.asset);
    const network = entry.slice(0, slash);
    const address = entry.slice(slash + 1).replace(/^erc20:/i, "");
    return matchesNetwork(network, terms.network) && sameAddress(address, terms.asset);
  });
}

/**
 * Running total of what one wrapper has signed — the state behind
 * `maxTotalAmount`. Reserve before signing, refund if the request never
 * reaches the seller, so a flood of failed retries cannot exhaust the budget
 * without paying, and a flood of 402s cannot exceed it.
 */
export interface SpendTracker {
  /** Try to reserve `amount`; false when it would exceed the budget */
  reserve(amount: bigint): boolean;
  refund(amount: bigint): void;
  spent(): bigint;
}

export function createSpendTracker(maxTotalAmount: string | undefined): SpendTracker {
  const budget = maxTotalAmount === undefined ? undefined : parseAmount(maxTotalAmount);
  if (maxTotalAmount !== undefined && budget === undefined) {
    throw new Error("maxTotalAmount must be a decimal atomic-unit string");
  }
  let total = 0n;
  return {
    reserve(amount) {
      if (budget !== undefined && total + amount > budget) return false;
      total += amount;
      return true;
    },
    refund(amount) {
      total -= amount;
    },
    spent: () => total,
  };
}

/**
 * The construction-time safety gate both wrapFetch and the axios adapter run.
 * `maxAmount` is a bare atomic-unit integer with no token or decimals attached,
 * so an asset allowlist is mandatory unless the caller explicitly opts into
 * "any asset" — otherwise a hostile 402 naming an expensive token at the same
 * integer yields a far more valuable signature than intended.
 */
export function assertBuyerPolicy(options: WrapFetchOptions): void {
  if (!options.maxAmount || parseAmount(options.maxAmount) === undefined) {
    throw new Error("buyer requires maxAmount (a decimal atomic-unit string) — an uncapped agent is an incident");
  }
  createSpendTracker(options.maxTotalAmount); // parse (and fail) at construction
  assertAssetAllowlist(options, "maxAmount");
}

/**
 * The allowlist gate shared by every signing entry point: a bare atomic-unit
 * cap (`capName`) is token-blind, so an asset allowlist is mandatory unless
 * the caller explicitly opts into any asset.
 */
export function assertAssetAllowlist(
  options: { assets?: string[] | undefined; allowAnyAsset?: boolean | undefined },
  capName: string,
): void {
  if ((!options.assets || options.assets.length === 0) && !options.allowAnyAsset) {
    throw new Error(
      `requires \`assets\` (a token-address allowlist) — ${capName} alone is token-blind, ` +
        "so hostile terms could name an expensive token. Pass `allowAnyAsset: true` to opt out.",
    );
  }
}

/**
 * Build the selection policy from options and pick a payable entry. Shared by
 * wrapFetch and the axios adapter so both apply the identical safety gates
 * (cap, consent, asset/network filters). Returns the chosen requirements, or
 * a rejection reason string.
 */
export function selectPayable(accepts: PaymentRequirements[], options: WrapFetchOptions): PaymentRequirements | string {
  return select(accepts, options.schemes ?? DEFAULT_BUYER_SCHEMES, {
    cap: BigInt(options.maxAmount),
    assets: options.assets,
    networks: options.networks,
    consented: new Set(options.consentTo ?? []),
  });
}

/** Default ceiling on how long a signed authorization stays valid (seconds) */
export const DEFAULT_MAX_VALIDITY_SECONDS = 300;

export const SKIP_REDIRECTED = "paid retry was redirected — refusing to forward the signature";
export const SKIP_CROSS_ORIGIN = "paid retry crossed origins — refusing to forward the signature";

export type PreparedPayment =
  | { skipped: string }
  | {
      chosen: PaymentRequirements;
      amount: bigint;
      /** Base64 PAYMENT-SIGNATURE header value */
      header: string;
      /** Give the budget back — the signature never reached the seller */
      refund(): void;
    };

/**
 * The whole "402 terms → signed header" step both transports share: pick a
 * payable entry, reserve it against the cumulative budget, clamp validity,
 * sign. Everything policy-shaped lives here; the callers only move bytes.
 */
export async function preparePayment(
  accepts: PaymentRequirements[],
  options: WrapFetchOptions,
  spend: SpendTracker,
): Promise<PreparedPayment> {
  const now = options.clock ? await options.clock() : nowSeconds();
  const chosen = selectPayable(accepts, options);
  if (typeof chosen === "string") return { skipped: chosen };
  const amount = parseAmount(chosen.amount) ?? 0n;
  if (!spend.reserve(amount)) {
    return { skipped: `amount ${chosen.amount} would exceed maxTotalAmount (spent ${spend.spent()})` };
  }
  const payload = await signPayment(chosen, {
    signer: options.signer,
    ...(options.schemes ? { schemes: options.schemes } : {}),
    now,
    // Clamp the on-chain validity to the buyer's ceiling regardless of what
    // the server proposed in maxTimeoutSeconds.
    validForSeconds: Math.min(Number(chosen.maxTimeoutSeconds), options.maxValiditySeconds ?? DEFAULT_MAX_VALIDITY_SECONDS),
    ...(options.permit2Proxy ? { permit2Proxy: options.permit2Proxy } : {}),
    ...(options.permit2Address ? { permit2Address: options.permit2Address } : {}),
    ...(options.uptoPermit2Proxy ? { uptoPermit2Proxy: options.uptoPermit2Proxy } : {}),
  });
  return {
    chosen,
    amount,
    header: encodePaymentPayload(payload),
    // The budget counts what was SIGNED, never what the seller later claims to
    // have charged. PAYMENT-RESPONSE is authored by the seller; refunding on
    // its say-so would let a hostile seller report amount:"0" every time and
    // void maxTotalAmount — the one guard that exists against that seller.
    // For upto the reservation is the cap (the worst case authorized); the
    // actual charge is visible via onPaid(settlement) for out-of-band accounting.
    refund: () => spend.refund(amount),
  };
}

/**
 * Wrap any fetch-compatible function. Non-402 responses pass through
 * untouched; a payable 402 is paid and retried exactly once.
 *
 * A Request input is cloned before the first send so its body survives the
 * retry. A streaming init.body still cannot be replayed — buffer bodies you
 * may need to pay for.
 *
 * Security posture: the signed payment is a bearer instrument. The paid retry
 * is sent with `redirect: "manual"` and only to the SAME origin as the first
 * request — the PAYMENT-SIGNATURE header is never followed to a redirect
 * target, which would hand the authorization to a third party.
 */
export function wrapFetch(fetchImpl: typeof fetch, options: WrapFetchOptions): typeof fetch {
  assertBuyerPolicy(options);
  const spend = createSpendTracker(options.maxTotalAmount);

  return async (input, init) => {
    const requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const first = await fetchImpl(input instanceof Request ? input.clone() : input, init);
    if (first.status !== 402) return first;

    const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) return first; // a 402 without terms is not an x402 endpoint

    // Safe decode — a hostile 402 body must never crash the agent's request
    // path; an unparseable one is handed back untouched.
    const decoded = decodePaymentRequiredSafe(header);
    if (!decoded.ok) return first;
    const accepts: PaymentRequirements[] = decoded.value.accepts;

    // The first request follows redirects. If the 402 came from somewhere
    // other than the origin the caller addressed (an open redirect on the
    // trusted host), its terms were authored by a third party — do not sign.
    const firstOrigin = new URL(first.url || requestedUrl).origin;
    if (first.url && new URL(requestedUrl, first.url).origin !== firstOrigin) {
      options.onSkipped?.("402 arrived from a different origin than requested — refusing to sign its terms", accepts);
      return first;
    }

    const prepared = await preparePayment(accepts, options, spend);
    if ("skipped" in prepared) {
      options.onSkipped?.(prepared.skipped, accepts);
      return first;
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(HEADER_PAYMENT_SIGNATURE, prepared.header);

    // Merge into a single request object (passing both a Request and init.headers
    // would drop the header per the fetch spec), and pin redirect + origin.
    const retry =
      input instanceof Request
        ? new Request(input, { ...init, headers, redirect: "manual" })
        : new Request(input as string | URL, { ...init, headers, redirect: "manual" });
    let second: Response;
    try {
      second = await fetchImpl(retry);
    } catch (e) {
      prepared.refund(); // never reached the seller — nobody holds the signature
      throw e;
    }

    // A redirect on the paid retry must not carry the signature onward
    if (second.type === "opaqueredirect" || (second.status >= 300 && second.status < 400)) {
      options.onSkipped?.(SKIP_REDIRECTED, accepts);
      return second;
    }
    if (second.url && new URL(second.url).origin !== firstOrigin) {
      options.onSkipped?.(SKIP_CROSS_ORIGIN, accepts);
      return second;
    }

    if (second.ok) {
      const settlementHeader = second.headers.get(HEADER_PAYMENT_RESPONSE);
      // Safe decode — a malformed receipt header must not fail a paid request.
      const settlement = settlementHeader ? decodeSettleResponseSafe(settlementHeader) : undefined;
      options.onPaid?.(prepared.chosen, settlement);
    }
    return second;
  };
}
