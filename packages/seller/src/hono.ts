/**
 * Hono adapter. Typed structurally so hono is not a dependency — any object
 * with `req.raw`, `header()`, and Hono's middleware shape works.
 *
 *   import { paywall } from "@x402kit/seller/hono";
 *   app.use("/premium/*", paywall({ accepts: [...], facilitator: "https://…" }));
 *
 * upto: a handler that knows the real charge sets
 * `c.header("Settlement-Overrides", JSON.stringify({ amount }))`; the
 * middleware reads it after next(), strips it, and settles that amount.
 */

import { HEADER_PAYMENT_RESPONSE } from "@x402kit/core";
import { createPaywall, takeSettlementOverrides, type PaywallOptions } from "./paywall.js";

interface HonoishContext {
  req: { raw: Request };
  header(name: string, value: string): void;
  /** Hono exposes the outgoing response after next(); optional so minimal stubs still type-check */
  res?: { headers: Headers };
}

type HonoishMiddleware = (c: HonoishContext, next: () => Promise<void>) => Promise<Response | void>;

export function paywall(options: PaywallOptions): HonoishMiddleware {
  const pw = createPaywall(options);
  return async (c, next) => {
    const decision = await pw.check(c.req.raw);
    if (!decision.paid) return decision.response;
    for (const [name, value] of Object.entries(decision.responseHeaders)) {
      c.header(name, value);
    }
    await next();
    // after-handler settlement: next() ran the downstream handler without
    // throwing. Hono lets a middleware set headers after next() (they land on
    // the final response), so PAYMENT-RESPONSE can still be attached.
    if (decision.capture) {
      const { header } = await decision.capture(takeSettlementOverrides(c.res?.headers));
      if (header) c.header(HEADER_PAYMENT_RESPONSE, header);
    }
  };
}
