/**
 * Pre-signed payment schedules — fixed-amount recurring (subscriptions,
 * installments) with NO new scheme and NO new on-chain code.
 *
 * The buyer signs n standard `exact` payments up front, one per billing
 * period, each confined to its own validity window and carrying its own
 * nonce. The seller stores them and settles one per period through any
 * standard facilitator: an early charge fails the scheme's own time check,
 * a consumed one cannot replay, and windows never authorize more than one
 * settlement each.
 *
 * Exposure model: the commitment is EXACTLY n × amount — there is no
 * open-ended pull authority. `maxTotalAmount` makes that bound explicit and
 * required, and calling this function IS the buyer's consent to the whole
 * schedule. Cancelling = telling the seller to stop; for permit2 payloads the
 * unused Permit2 nonces can additionally be invalidated on-chain.
 */

import type { Address } from "viem";
import {
  matchesNetwork,
  parseAmount,
  sameAddress,
  type AnyExactPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
} from "@x402kit/core";
import { signPayment } from "./signPayment.js";
import { assertAssetAllowlist, assetAllowed } from "./wrapFetch.js";

/** One billing window, unix seconds. The payment is settleable only inside it */
export interface SchedulePeriod {
  start: number;
  end: number;
}

/** Sugar for evenly spaced periods: [start, start+p), [start+p, start+2p), … */
export interface EvenPeriods {
  start: number;
  periodSeconds: number;
  count: number;
}

export interface SignPaymentScheduleOptions {
  signer: PaymentSigner;
  /** Billing windows — explicit list, or evenly spaced via {start, periodSeconds, count} */
  periods: SchedulePeriod[] | EvenPeriods;
  /**
   * Hard cap on the WHOLE schedule (atomic units). Signing refuses when
   * n × amount exceeds it. Required on purpose — a schedule is a standing
   * commitment, and an unbounded one is an incident.
   */
  maxTotalAmount: string;
  /**
   * Token addresses this buyer will commit to. REQUIRED unless `allowAnyAsset`
   * — `maxTotalAmount` is a bare atomic-unit number with no notion of which
   * token or how many decimals, so terms from a seller naming an expensive
   * token at the same integer would pass the cap with a far more valuable
   * commitment than intended. Same gate as wrapFetch.
   */
  assets?: string[];
  /** Opt in to committing to ANY token that fits `maxTotalAmount` */
  allowAnyAsset?: boolean;
  /** Restrict to these CAIP-2 networks/patterns. Default: any network the scheme supports */
  networks?: string[];
  /** exact/permit2 overrides for private/test deployments (see BuildPayloadOptions) */
  permit2Proxy?: Address;
  permit2Address?: Address;
}

const MAX_INSTALLMENTS = 1000;

function normalizePeriods(periods: SchedulePeriod[] | EvenPeriods): SchedulePeriod[] {
  // Bound before materializing anything — a huge count would OOM the signer
  // before the maxTotalAmount cap below could reject it.
  const total = Array.isArray(periods) ? periods.length : periods.count;
  if (total > MAX_INSTALLMENTS) throw new Error(`${total} installments exceeds the ${MAX_INSTALLMENTS}-installment maximum`);
  if (Array.isArray(periods)) return periods;
  const { start, periodSeconds, count } = periods;
  // Positivity/length problems surface through the per-period checks below;
  // only non-integers would slip through silently (Array.from truncates).
  if (!Number.isInteger(periodSeconds) || !Number.isInteger(count)) {
    throw new Error("periodSeconds and count must be integers");
  }
  return Array.from({ length: count }, (_, i) => ({
    start: start + i * periodSeconds,
    end: start + (i + 1) * periodSeconds,
  }));
}

/**
 * Sign one standard `exact` payment per billing period. Returns the payloads
 * in period order — hand them to the seller over your subscribe channel; each
 * one settles through any standard facilitator, unchanged.
 *
 * Each installment is settleable only within [start, end) in chain time —
 * adjacent periods never overlap.
 */
export async function signPaymentSchedule(
  requirements: PaymentRequirements,
  options: SignPaymentScheduleOptions,
): Promise<PaymentPayload<AnyExactPayload>[]> {
  if (requirements.scheme !== "exact") {
    throw new Error(`payment schedules pre-sign exact payments — got scheme "${requirements.scheme}"`);
  }
  assertAssetAllowlist(options, "maxTotalAmount");
  if (options.assets && !assetAllowed(options.assets, requirements)) {
    throw new Error(`requirements.asset ${requirements.asset} is not in the buyer's asset allowlist`);
  }
  if (options.networks && !options.networks.some((p) => matchesNetwork(p, requirements.network))) {
    throw new Error(`requirements.network ${requirements.network} is not in the buyer's network allowlist`);
  }
  const amount = parseAmount(requirements.amount);
  if (amount === undefined || amount === 0n) throw new Error("requirements.amount must be a positive atomic-unit amount");

  const periods = normalizePeriods(options.periods);
  if (periods.length === 0) throw new Error("a schedule needs at least one period");
  for (const [i, p] of periods.entries()) {
    if (!Number.isInteger(p.start) || !Number.isInteger(p.end) || p.end <= p.start) {
      throw new Error(`period ${i} is malformed: end must be after start (unix seconds)`);
    }
    // Strict eip3009 bounds shave a second off each end — anything shorter
    // than a few seconds has no settleable instant left. Real periods are days.
    if (p.end - p.start < 4) {
      throw new Error(`period ${i} is too short to contain a settleable instant`);
    }
    const prev = periods[i - 1];
    if (prev && p.start < prev.end) {
      throw new Error(`period ${i} overlaps period ${i - 1} — windows must be in order and disjoint`);
    }
  }

  const total = amount * BigInt(periods.length);
  const cap = parseAmount(options.maxTotalAmount);
  if (cap === undefined) throw new Error("maxTotalAmount must be an atomic-unit amount string");
  if (total > cap) {
    throw new Error(`schedule total ${total} (${periods.length} × ${requirements.amount}) exceeds maxTotalAmount ${cap}`);
  }

  return Promise.all(
    periods.map(
      (p) =>
        // signPayment routes through the shared handler resolution (scheme AND
        // network capability) and forwards the window: validity starts at
        // p.start, expiry at p.end - 1 — confined within [start, end), so
        // adjacent periods never overlap and a due check at any instant
        // matches at most one installment. (eip3009's strict bounds shave one
        // more second off each end.)
        signPayment(requirements, {
          signer: options.signer,
          validAfter: p.start,
          now: p.start,
          validForSeconds: p.end - 1 - p.start,
          ...(options.permit2Proxy ? { permit2Proxy: options.permit2Proxy } : {}),
          ...(options.permit2Address ? { permit2Address: options.permit2Address } : {}),
        }) as Promise<PaymentPayload<AnyExactPayload>>,
    ),
  );
}
