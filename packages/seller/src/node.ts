/**
 * node:http adapter — for servers with no framework at all (and for the kit's
 * own e2e). Also home to the IncomingMessage → web Request conversion and the
 * decision → ServerResponse translation the express adapter reuses: how a
 * PaywallDecision becomes a node response is one fact, written once.
 */

import {
  SETTLEMENT_OVERRIDES_HEADER,
  createPaywall,
  parseSettlementOverrides,
  type CaptureOptions,
  type Paywall,
  type PaywallDecision,
  type PaywallOptions,
} from "./paywall.js";

export interface NodeRequestLike {
  // `| undefined` is explicit so IncomingMessage matches under exactOptionalPropertyTypes
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  /** Optional (present on ServerResponse) — lets a handler pick the upto settle amount via Settlement-Overrides */
  getHeader?(name: string): number | string | string[] | undefined;
  removeHeader?(name: string): void;
}

/**
 * Read (and strip) the handler's Settlement-Overrides header. Reading happens
 * after the handler ran; stripping only works if headers are not yet flushed.
 */
function takeOverrides(res: NodeResponseLike): CaptureOptions | undefined {
  const raw = res.getHeader?.(SETTLEMENT_OVERRIDES_HEADER);
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    res.removeHeader?.(SETTLEMENT_OVERRIDES_HEADER);
  } catch {
    /* headers already sent — the value was still read */
  }
  return parseSettlementOverrides(typeof value === "string" ? value : undefined);
}

/**
 * Headers are all the paywall reads, so the body is not consumed.
 * The synthesized origin only matters for the default resource URL — and
 * `Host` is client-controlled, so a garbage value must not throw (raw
 * node:http does not validate it) and a proxy's `x-forwarded-proto` is
 * honoured so the advertised resource is https when the site is.
 */
export function requestFromNode(req: NodeRequestLike): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    try {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    } catch {
      /* an invalid header name/value from the wire is dropped, not fatal */
    }
  }
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ? "https" : "http";
  const host = headers.get("host") ?? "localhost";
  const init = { method: req.method ?? "GET", headers };
  try {
    return new Request(`${proto}://${host}${req.url ?? "/"}`, init);
  } catch {
    return new Request(`${proto}://localhost${req.url ?? "/"}`, init);
  }
}

/**
 * Write a decision to a node response. Returns true when the request is paid
 * and the caller should proceed to its own handler.
 */
export async function applyDecision(res: NodeResponseLike, decision: PaywallDecision): Promise<boolean> {
  if (decision.paid) {
    for (const [name, value] of Object.entries(decision.responseHeaders)) {
      res.setHeader(name, value);
    }
    return true;
  }
  res.statusCode = decision.response.status;
  decision.response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(await decision.response.text());
  return false;
}

/**
 * Gate a plain node:http handler behind any Paywall-shaped check — used by
 * withPaywall and by custom gates alike.
 */
export function withGate<Req extends NodeRequestLike, Res extends NodeResponseLike>(
  gate: Paywall,
  handler: (req: Req, res: Res) => void | Promise<void>,
): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    const decision = await gate.check(requestFromNode(req));
    if (!(await applyDecision(res, decision))) return;
    await handler(req, res);
    // after-handler settlement: only reached if the handler didn't throw. The
    // response body is already being written, so the PAYMENT-RESPONSE header is
    // reported via onSettled rather than attached here. A handler that set
    // Settlement-Overrides (upto) picks the amount.
    if (decision.paid && decision.capture) await decision.capture(takeOverrides(res));
  };
}

/**
 * Wrap a plain node:http handler: the wrapped handler only runs once payment
 * clears, with the PAYMENT-RESPONSE header already set.
 */
export function withPaywall<Req extends NodeRequestLike, Res extends NodeResponseLike>(
  options: PaywallOptions,
  handler: (req: Req, res: Res) => void | Promise<void>,
): (req: Req, res: Res) => Promise<void> {
  return withGate(createPaywall(options), handler);
}
