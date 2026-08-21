/**
 * Seller side of pre-signed payment schedules (see @x402.kit/buyer
 * signPaymentSchedule): accept n pre-signed exact payments, store them, and
 * settle one per period through any standard facilitator.
 *
 * The kit stays a library, not a daemon — the seller owns storage and the
 * cron; these helpers own validation, window math, and submission. Time
 * enforcement is the SCHEME's own: an early submission fails verify with the
 * exact time-check reason, so `dueEntries` is a round-trip saver, not the
 * security boundary.
 *
 * Acceptance-time honesty: future-window signatures cannot be fully verified
 * up front (a facilitator /verify would correctly reject them as not yet
 * valid). validateSchedule checks shape, terms match, window order, and
 * payment-identity uniqueness; verify the FIRST due entry through the
 * facilitator before treating a subscription as live — a bad later signature
 * surfaces as a failed charge at its period, bounded to that period's amount.
 */

import {
  exactPaymentWindow,
  exactScheme,
  isPermit2Payload,
  nowSeconds,
  parsePaymentPayload,
  selectRequirements,
  type AnyExactPayload,
  type ParseResult,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "@x402.kit/core";
import { toFacilitator, type FacilitatorLike } from "./client.js";

/** One stored installment: the pre-signed payload and the terms it settles under */
export interface ScheduleEntry {
  payload: PaymentPayload<AnyExactPayload>;
  requirements: PaymentRequirements;
}

/**
 * The settleable window of one pre-signed payment (inclusive chain-time
 * seconds), derived from the payload itself — the seller stores nothing
 * beyond the entry. Delegates to core's single window reader.
 */
export const scheduleWindow = exactPaymentWindow;

/**
 * Upper bound on installments in one submission — a year of daily periods is
 * 365, so this is generous. Rejects a hostile huge array before the per-entry
 * parse loop can stall the seller's event loop.
 */
export const MAX_SCHEDULE_ENTRIES = 1000;

/** Default ceiling on how far into the future a schedule may reach: ~13 months */
export const DEFAULT_MAX_HORIZON_SECONDS = 400 * 86_400;

export interface ValidateScheduleOptions {
  /** Reference time (unix seconds). Default: wall clock */
  now?: number;
  /**
   * Reject entries whose window ends later than `now + maxHorizonSeconds`.
   * Every stored entry is a live bearer authorization for `amount`; a
   * schedule that runs to the year 36812 is an unbounded liability sitting
   * in your database. Default 400 days.
   */
  maxHorizonSeconds?: number;
  /**
   * Reject a schedule whose FIRST window already closed more than this many
   * seconds ago — it would validate and then silently never bill. Default 1 day.
   */
  maxPastSeconds?: number;
}

/**
 * The facilitator-side identity of one installment — persist it with the
 * charge result so your cron can skip entries that already settled (see
 * dueEntries' `isSettled`).
 */
export function scheduleEntryId(entry: ScheduleEntry): string {
  return exactScheme.paymentId(entry.payload, entry.requirements);
}

/**
 * Validate an untrusted schedule submission (e.g. a subscribe endpoint's JSON
 * body: an array of PaymentPayload objects) against the terms you offered.
 */
export function validateSchedule(
  raw: unknown,
  accepts: PaymentRequirements[],
  opts: ValidateScheduleOptions = {},
): ParseResult<ScheduleEntry[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "schedule must be a non-empty array of payment payloads" };
  }
  if (raw.length > MAX_SCHEDULE_ENTRIES) {
    return { ok: false, error: `schedule has ${raw.length} entries; the maximum is ${MAX_SCHEDULE_ENTRIES}` };
  }
  const now = opts.now ?? nowSeconds();
  const horizon = now + (opts.maxHorizonSeconds ?? DEFAULT_MAX_HORIZON_SECONDS);
  const earliestEnd = now - (opts.maxPastSeconds ?? 86_400);
  const entries: ScheduleEntry[] = [];
  const identities = new Set<string>();
  let lastNotAfter = -Infinity;
  for (const [i, item] of raw.entries()) {
    const parsed = parsePaymentPayload(item);
    if (!parsed.ok) return { ok: false, error: `entry ${i}: ${parsed.error}` };
    // zod's inferred shape (payload as a plain record) narrows to the exact
    // payload union at the scheme layer — same erasure point as the registry.
    const payload = parsed.value as unknown as PaymentPayload<AnyExactPayload>;
    const requirements = selectRequirements(accepts, payload);
    if (!requirements) return { ok: false, error: `entry ${i}: signed terms match none of the offered accepts[]` };
    if (requirements.scheme !== "exact") return { ok: false, error: `entry ${i}: schedules carry exact payments only` };
    // Shape gate BEFORE touching method-specific fields: the wire schema only
    // guarantees `payload` is an object. isPermit2Payload only checks the
    // authorization is present, so verify the nested fields window math reads.
    const inner = payload.payload as Partial<{
      authorization: { from?: unknown };
      permit2Authorization: { witness?: unknown; deadline?: unknown };
    }>;
    if (isPermit2Payload(payload.payload)) {
      const p2 = inner.permit2Authorization ?? {};
      if (typeof p2.witness !== "object" || p2.witness === null || p2.deadline === undefined) {
        return { ok: false, error: `entry ${i}: malformed permit2 authorization` };
      }
    } else if (typeof inner.authorization !== "object" || inner.authorization === null) {
      return { ok: false, error: `entry ${i}: not an exact payment payload` };
    }

    // paymentId is the facilitator's idempotency identity — two entries that
    // share it would be deduplicated into ONE settlement, so they are not
    // independent periods.
    const id = exactScheme.paymentId(payload, requirements);
    if (identities.has(id)) return { ok: false, error: `entry ${i}: duplicate payment identity — not an independent payment` };
    identities.add(id);

    // Both bounds must be finite real timestamps (a deadline of "1e999" would
    // otherwise yield Infinity and a permanently-"due" installment), and each
    // window must start strictly after the previous one ENDS — disjoint, so no
    // instant ever makes two installments due at once.
    const window = scheduleWindow(payload);
    if (!Number.isFinite(window.notBefore) || !Number.isFinite(window.notAfter) || window.notAfter <= window.notBefore) {
      return { ok: false, error: `entry ${i}: malformed validity window` };
    }
    if (window.notBefore <= lastNotAfter) {
      return { ok: false, error: `entry ${i}: window overlaps the previous period — must be ordered and disjoint` };
    }
    if (window.notAfter > horizon) {
      return { ok: false, error: `entry ${i}: window ends beyond the ${opts.maxHorizonSeconds ?? DEFAULT_MAX_HORIZON_SECONDS}s horizon` };
    }
    if (i === 0 && window.notAfter < earliestEnd) {
      return { ok: false, error: "entry 0: the first window already closed — this schedule would never bill" };
    }
    lastNotAfter = window.notAfter;
    entries.push({ payload, requirements });
  }
  return { ok: true, value: entries };
}

export interface DueEntriesOptions {
  /**
   * Has this installment (by `scheduleEntryId`) already settled? Entries
   * that have are skipped. Without it, a cron that runs more than once per
   * period resubmits the settled payment every run — the chain rejects the
   * consumed nonce so no double charge lands, but each attempt costs the
   * facilitator a simulation and you cannot tell "paid" from "failed"
   * without parsing reasons. Persist the id with each successful charge.
   */
  isSettled?(id: string, entry: ScheduleEntry): boolean;
}

/** The entries currently inside their settleable window — feed these to your cron's charge loop */
export function dueEntries(entries: readonly ScheduleEntry[], now: number, opts: DueEntriesOptions = {}): ScheduleEntry[] {
  return entries.filter((e) => {
    const w = scheduleWindow(e.payload);
    if (now < w.notBefore || now > w.notAfter) return false;
    return !opts.isSettled?.(scheduleEntryId(e), e);
  });
}

/**
 * Settle one scheduled installment through the facilitator. Submission is all
 * this does — idempotency is the facilitator's (same payload → same result),
 * and time enforcement is the scheme's (early → the exact valid-after reason).
 */
export function chargeScheduled(
  entry: ScheduleEntry,
  facilitator: FacilitatorLike | string,
): Promise<SettleResponse> {
  return toFacilitator(facilitator).settle({
    x402Version: 2,
    paymentPayload: entry.payload,
    paymentRequirements: entry.requirements,
  });
}
