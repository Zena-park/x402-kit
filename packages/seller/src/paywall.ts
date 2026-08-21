/**
 * Paywall core — framework-agnostic, built on web-standard Request/Response.
 *
 * `check()` implements the whole seller side of the protocol:
 *   no payment header      -> 402 with PAYMENT-REQUIRED
 *   malformed payment      -> 402 (invalid_payload)
 *   unknown terms echoed   -> 402 (invalid_payment_requirements), no facilitator call
 *   replayed payment       -> 402 (authorization_already_used), no facilitator call
 *   verify rejected        -> 402 with the reason and fresh terms
 *   facilitator down       -> 503 (facilitator_unavailable) — never a 500/stack
 *   verified               -> settle (sync by default) -> paid, with the
 *                             PAYMENT-RESPONSE header ready to attach
 *
 * The framework adapters (hono/express/node) only translate decisions into
 * their response models. Everything protocol-shaped lives here; everything
 * scheme-shaped lives in the handlers (validateRequirements at construction,
 * matching via core's selectRequirements).
 */

import {
  ErrorReason,
  ErrorReasonExtra,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  buildPaymentRequired,
  decodePaymentPayloadSafe,
  encodeSettleResponse,
  exactScheme,
  resolveHandler,
  selectRequirements,
  uptoScheme,
  type AnySchemeHandler,
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "@x402kit/core";
import { FacilitatorClient, FacilitatorUnreachableError, toFacilitator, type FacilitatorLike } from "./client.js";
import { createMemoryReplayStore, type ReplayStore } from "./replay.js";

let sharedReplayStore: ReplayStore | undefined;
function defaultReplayStore(): ReplayStore {
  return (sharedReplayStore ??= createMemoryReplayStore());
}
/** @internal Drop the process-wide default replay store — test isolation only */
export function resetDefaultReplayStore(): void {
  sharedReplayStore = undefined;
}

/**
 * A real exact payload encodes to ~1 KB. Anything past this is not a payment;
 * refuse before base64 + JSON + schema work (and before forwarding the blob
 * to the facilitator on every request).
 */
export const MAX_PAYMENT_HEADER_BYTES = 8 * 1024;

/** Reason codes the paywall will echo into a 402. Anything else becomes a generic message */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(ErrorReason),
  ...Object.values(ErrorReasonExtra),
]);

export interface PaywallOptions {
  /** The payment terms to demand — the 402's accepts[] */
  accepts: PaymentRequirements[];
  /** Facilitator URL, or anything implementing verify/settle (e.g. an embedded createFacilitator()) */
  facilitator: string | FacilitatorLike;
  /** Schemes these terms may use. Default: [exactScheme, uptoScheme] */
  schemes?: AnySchemeHandler[];
  /** Resource shown in the 402. Defaults to the request URL */
  resource?: ResourceInfo | ((request: Request) => ResourceInfo);
  /**
   * "sync" (default): settle before responding, PAYMENT-RESPONSE carries the tx.
   * "async": respond right after verify (approve/capture split — POS-style);
   *          settlement runs in the background and reports via onSettled.
   * "after-handler": defer settlement so a handler that 500s never charges the
   *          buyer for nothing. The decision carries a `capture()` the adapter
   *          invokes. Wrapper adapters (node `withGate`/`withPaywall`, next,
   *          hono) call it AFTER the handler — true after-handler semantics.
   *          Hook-style express/fastify run before the handler, so they settle
   *          at that point (effectively sync); the guarantee there is only
   *          "settlement is not skipped", not "skip on handler failure".
   * "none":  verify-only gate — the caller takes custody of the verified
   *          payload via onVerified (which is therefore required).
   *
   * In every mode but "sync" the goods leave before the chain consumes the
   * nonce, so the replay guard (`replayStore`) is what makes one signature
   * buy one delivery. It is on by default.
   */
  settle?: "sync" | "async" | "after-handler" | "none";
  /** Observability for settlement — the channel in async and after-handler modes */
  onSettled?(result: SettleResponse, payload: PaymentPayload): void;
  /** Called once a payment verifies, before any settlement */
  onVerified?(payload: PaymentPayload, requirements: PaymentRequirements): void | Promise<void>;
  /**
   * Replay guard keyed on the scheme's paymentId (the signed nonce). Default:
   * one in-process TTL store shared by every paywall() in the process, so a
   * header paid to one route cannot be replayed against a sibling route.
   * Multi-instance deployments should pass a shared one (Redis SET NX).
   * `false` disables it — only sane when settle is "sync" AND you accept the
   * short pre-mining window.
   */
  replayStore?: ReplayStore | false;
  /**
   * Refuse a payload whose `resource.url` names a different resource than
   * this paywall serves (a payment signed for /cheap-a presented at /cheap-b).
   * Only enforced when the payload carries `resource`. Default true.
   */
  bindResource?: boolean;
}

export interface CaptureOptions {
  /** Actual amount to settle (atomic units), ≤ the signed amount. upto only — exact ignores it */
  amount?: string;
}

/**
 * Response header a handler sets to pick the settle-time amount when it has
 * no access to `capture()` itself (hono/next/node wrapper adapters read and
 * strip it): `Settlement-Overrides: {"amount":"1234"}`. Same name and shape
 * as the reference SDK, so handlers port across unchanged.
 */
export const SETTLEMENT_OVERRIDES_HEADER = "settlement-overrides";

/** Parse a Settlement-Overrides header value. Malformed → undefined (settle the full amount) */
export function parseSettlementOverrides(value: string | null | undefined): CaptureOptions | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { amount?: unknown };
    return typeof parsed?.amount === "string" ? { amount: parsed.amount } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read AND strip Settlement-Overrides from a web-standard Headers — the
 * adapters that hold one (hono, next) share this; node's ServerResponse API
 * differs and reads it its own way. The header never reaches the client.
 */
export function takeSettlementOverrides(headers: Headers | undefined): CaptureOptions | undefined {
  const overrides = parseSettlementOverrides(headers?.get(SETTLEMENT_OVERRIDES_HEADER));
  try {
    headers?.delete(SETTLEMENT_OVERRIDES_HEADER);
  } catch {
    /* immutable Headers (Response.redirect etc.) — the value was still read */
  }
  return overrides;
}

export type PaywallDecision =
  | { paid: false; response: Response }
  | {
      paid: true;
      responseHeaders: Record<string, string>;
      settlement?: SettleResponse;
      /**
       * Present only in "after-handler" mode: the adapter MUST call this after
       * the handler succeeds to actually settle. Returns the PAYMENT-RESPONSE
       * header value on success (attach it if the response isn't sent yet), or
       * undefined. Calling it more than once is a no-op after the first — the
       * FIRST call's `amount` wins. Never rejects — a facilitator outage
       * surfaces as a failed settlement through `onSettled`, the seller's
       * accounting channel in this mode.
       *
       * `amount` (atomic units) settles less than the signed figure — the
       * `upto` scheme's whole point (sign a cap, charge the actual; "0" charges
       * nothing). Omitted → the full amount. Refused by the scheme's
       * `settleAmount` (above the cap) → a failed settlement reported via
       * onSettled, no facilitator call. Fixed-amount schemes (exact) ignore it.
       */
      capture?: (opts?: CaptureOptions) => Promise<{ header?: string; settlement: SettleResponse }>;
    };

export interface Paywall {
  check(request: Request): Promise<PaywallDecision>;
  /**
   * Optional startup check: fetch the facilitator's /supported and assert every
   * accepts[] entry (scheme+network) is advertised. Call once at boot to catch
   * a misconfigured route before the first customer. Throws on mismatch;
   * no-op if the facilitator is embedded (not a URL client).
   */
  verifySupported(): Promise<void>;
}

const NO_HEADERS: Record<string, string> = Object.freeze({});

/** Shape-check a facilitator answer: a truthy non-boolean must never read as "valid" */
function validVerify(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { isValid?: unknown }).isValid === true;
}

function settledOk(s: SettleResponse | undefined, network: string): s is SettleResponse & { success: true } {
  return typeof s === "object" && s !== null && s.success === true && s.network === network;
}

export function createPaywall(options: PaywallOptions): Paywall {
  if (options.accepts.length === 0) {
    throw new Error("paywall needs at least one PaymentRequirements in accepts");
  }
  if (options.settle === "none" && !options.onVerified) {
    throw new Error('settle: "none" grants access without settling — onVerified must take custody of the payload');
  }
  // Fail at construction, not at the first lost sale. What "well-formed terms"
  // means is the scheme's knowledge, not the seller's.
  const schemes = options.schemes ?? [exactScheme, uptoScheme];
  for (const req of options.accepts) {
    const resolved = resolveHandler(schemes, req);
    if ("error" in resolved) {
      throw new Error(`accepts entry (${req.scheme} on ${req.network}): ${resolved.error}`);
    }
    const problem = resolved.handler.validateRequirements?.(req);
    if (problem) throw new Error(`accepts entry invalid: ${problem}`);
  }

  const facilitator: FacilitatorLike = toFacilitator(options.facilitator);
  // One process-wide default store, not one per paywall(): a seller that
  // mounts two routes with identical terms must not accept the same signed
  // header on each — paymentId is global to the signature, so the claim is too.
  const replay: ReplayStore | undefined =
    options.replayStore === false ? undefined : (options.replayStore ?? defaultReplayStore());
  const bindResource = options.bindResource ?? true;

  function resourceFor(request: Request): ResourceInfo {
    if (typeof options.resource === "function") return options.resource(request);
    return options.resource ?? { url: request.url };
  }

  function paymentRequired(resource: ResourceInfo, error: string): Response {
    const body = buildPaymentRequired({ resource, accepts: options.accepts, error });
    // One stringify serves both the body and the header (base64 of the same JSON)
    const json = JSON.stringify(body);
    return new Response(json, {
      status: 402,
      headers: {
        "content-type": "application/json",
        [HEADER_PAYMENT_REQUIRED]: Buffer.from(json, "utf8").toString("base64"),
      },
    });
  }

  /** A facilitator-supplied reason is echoed only if it is a known protocol code */
  function rejected(resource: ResourceInfo, reason: unknown, fallback: string): PaywallDecision {
    const code = typeof reason === "string" && KNOWN_REASONS.has(reason) ? reason : fallback;
    return { paid: false, response: paymentRequired(resource, code) };
  }

  function unavailable(): PaywallDecision {
    return {
      paid: false,
      response: new Response(JSON.stringify({ error: "facilitator_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      }),
    };
  }

  /** The seller's own replay TTL: the terms' validity window, at least 5 minutes */
  function claimTtlMs(req: PaymentRequirements): number {
    return Math.max(req.maxTimeoutSeconds, 300) * 1000;
  }

  function settleFailure(
    network: PaymentRequirements["network"],
    errorReason: string = ErrorReason.UNEXPECTED_SETTLE_ERROR,
  ): SettleResponse {
    return { success: false, errorReason, transaction: "", network };
  }

  return {
    async verifySupported() {
      // Only a URL-backed client can advertise /supported; an embedded
      // facilitator is trusted to handle whatever it was constructed with.
      if (!(facilitator instanceof FacilitatorClient)) return;
      const supported = await facilitator.supported();
      const kinds = new Set(supported.kinds.map((k) => `${k.scheme}|${k.network}`));
      for (const req of options.accepts) {
        if (!kinds.has(`${req.scheme}|${req.network}`)) {
          throw new Error(
            `facilitator does not advertise ${req.scheme} on ${req.network} — check the accepts[] or the facilitator config`,
          );
        }
      }
    },

    async check(request) {
      const resource = resourceFor(request);
      const refuse = (reason: string): PaywallDecision => ({ paid: false, response: paymentRequired(resource, reason) });

      const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);
      if (!header) return refuse(`${HEADER_PAYMENT_SIGNATURE} header is required`);
      if (header.length > MAX_PAYMENT_HEADER_BYTES) return refuse(ErrorReason.INVALID_PAYLOAD);

      // Safe decode — a crafted header (bad base64, malformed amount, missing
      // fields) becomes a clean 402, never a 500 crash of the seller.
      const decoded = decodePaymentPayloadSafe(header);
      if (!decoded.ok) return refuse(ErrorReason.INVALID_PAYLOAD);
      const payload: PaymentPayload = decoded.value;

      // The payload's `accepted` must echo one of our accepts[] — terms we
      // never offered are a protocol error, not something to send onward.
      const chosen = selectRequirements(options.accepts, payload);
      if (!chosen) return refuse(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
      const resolved = resolveHandler(schemes, chosen);
      if ("error" in resolved) return refuse(resolved.error);

      // A payment signed for another resource is not payment for this one.
      if (bindResource && payload.resource?.url && payload.resource.url !== resource.url) {
        return refuse(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
      }

      // Replay guard — claim the signed identity BEFORE any facilitator call.
      // Concurrent copies of one header race here, and exactly one wins.
      const paymentId = resolved.handler.paymentId(payload, chosen);
      if (replay && !(await replay.claim(paymentId, claimTtlMs(chosen)))) {
        return refuse(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
      }
      const release = async (): Promise<void> => {
        await replay?.release(paymentId);
      };
      /**
       * One rule for every settle mode: a definite failure gives the claim
       * back (a corrected retry must not be locked out); a success or a
       * PENDING keeps it (the tx may still land — the same header must not be
       * re-presented while it is in flight). Then report via onSettled.
       */
      const concludeSettle = async (result: SettleResponse): Promise<boolean> => {
        const ok = settledOk(result, chosen.network);
        if (!ok && result?.errorReason !== ErrorReasonExtra.SETTLEMENT_PENDING) await release();
        options.onSettled?.(result, payload);
        return ok;
      };

      const facilitatorRequest = {
        x402Version: 2 as const,
        paymentPayload: payload,
        paymentRequirements: chosen,
      };

      let verified: Awaited<ReturnType<FacilitatorLike["verify"]>>;
      try {
        verified = await facilitator.verify(facilitatorRequest);
      } catch (e) {
        await release();
        if (e instanceof FacilitatorUnreachableError) return unavailable();
        throw e;
      }
      if (!validVerify(verified)) {
        await release();
        return rejected(resource, verified?.invalidReason, "payment invalid");
      }
      // The seller's own hook runs after the claim: if it throws, give the
      // claim back (the buyer could otherwise not retry for the TTL) and
      // answer 503 instead of letting a 500 with a stack escape the paywall.
      try {
        await options.onVerified?.(payload, chosen);
      } catch {
        await release();
        return unavailable();
      }

      if (options.settle === "none") {
        return { paid: true, responseHeaders: NO_HEADERS };
      }

      if (options.settle === "async") {
        // Approve/capture split: the goods go out on verify; capture runs behind.
        // Who carries the risk in between is the operator's policy, not code.
        void facilitator.settle(facilitatorRequest).catch(() => settleFailure(chosen.network)).then(concludeSettle);
        return { paid: true, responseHeaders: NO_HEADERS };
      }

      if (options.settle === "after-handler") {
        // Defer settlement to the adapter, which calls capture() only after the
        // handler succeeds — a handler that throws never charges the buyer.
        // Memoize the in-flight promise (not just the resolved value) so even
        // concurrent capture() calls settle exactly once. Never rejects: the
        // handler's response is already on the wire by then, so the only
        // honest channel for a failure is onSettled.
        let inflight: Promise<{ header?: string; settlement: SettleResponse }> | undefined;
        const capture = (opts?: CaptureOptions): Promise<{ header?: string; settlement: SettleResponse }> => {
          if (inflight) return inflight;
          // Phase-dependent amount: the scheme judges the seller's figure
          // (upto: ≤ the signed cap) and the settle request carries it in
          // paymentRequirements.amount — the payload is untouched. A refused
          // figure is a seller bug surfaced via onSettled, never a facilitator
          // round trip. Schemes without settleAmount ignore the override.
          const judged =
            opts?.amount !== undefined ? resolved.handler.settleAmount?.(opts.amount, chosen) : undefined;
          const settled: Promise<SettleResponse> =
            judged && "error" in judged
              ? Promise.resolve(settleFailure(chosen.network, judged.error))
              : facilitator
                  .settle(
                    judged ? { ...facilitatorRequest, paymentRequirements: { ...chosen, amount: judged.amount } } : facilitatorRequest,
                  )
                  .catch(() => settleFailure(chosen.network));
          inflight = settled.then(async (result) =>
              (await concludeSettle(result))
                ? { header: encodeSettleResponse(result), settlement: result }
                : { settlement: result },
            );
          return inflight;
        };
        return { paid: true, responseHeaders: NO_HEADERS, capture };
      }

      let settlement: SettleResponse;
      try {
        settlement = await facilitator.settle(facilitatorRequest);
      } catch (e) {
        await release();
        if (e instanceof FacilitatorUnreachableError) return unavailable();
        throw e;
      }
      if (!(await concludeSettle(settlement))) return rejected(resource, settlement?.errorReason, "settlement failed");
      return {
        paid: true,
        settlement,
        responseHeaders: { [HEADER_PAYMENT_RESPONSE]: encodeSettleResponse(settlement) },
      };
    },
  };
}
