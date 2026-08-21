/**
 * Next.js App Router adapter. Typed structurally so next is not a dependency —
 * App Router route handlers are plain `(Request) => Response`, which is exactly
 * what createPaywall already speaks.
 *
 *   // app/api/premium/route.ts
 *   import { withPaywall } from "@x402kit/seller/next";
 *   export const GET = withPaywall(
 *     { accepts: [...], facilitator: "https://…" },
 *     async (req) => Response.json({ data: "premium" }),
 *   );
 *
 * On no/invalid payment the wrapped handler never runs — the 402 is returned
 * directly. On success the handler runs and PAYMENT-RESPONSE is attached to
 * its response.
 */

import { HEADER_PAYMENT_RESPONSE } from "@x402kit/core";
import { createPaywall, takeSettlementOverrides, type Paywall, type PaywallOptions } from "./paywall.js";

type RouteHandler<Ctx> = (request: Request, ctx: Ctx) => Response | Promise<Response>;

export function withPaywall<Ctx = unknown>(
  options: PaywallOptions,
  handler: RouteHandler<Ctx>,
): RouteHandler<Ctx> {
  const pw: Paywall = createPaywall(options);
  return async (request, ctx) => {
    const decision = await pw.check(request);
    if (!decision.paid) return decision.response;
    let response = await handler(request, ctx);

    const headers: Record<string, string> = { ...decision.responseHeaders };
    // after-handler settlement: the handler returned without throwing, so
    // settle now and attach PAYMENT-RESPONSE.
    if (decision.capture) {
      // upto: the handler names the actual charge via Settlement-Overrides.
      // An immutable Response keeps the header here; it is dropped when the
      // mutable copy is made below.
      const { header } = await decision.capture(takeSettlementOverrides(response.headers));
      if (header) headers[HEADER_PAYMENT_RESPONSE] = header;
    }
    // A handler Response can be immutable (Response.redirect, a proxied fetch
    // Response). Setting a header on it would throw and turn a PAID request
    // into a 500, so fall back to a mutable copy.
    for (const [name, value] of Object.entries(headers)) {
      try {
        response.headers.set(name, value);
      } catch {
        response = new Response(response.body, response);
        takeSettlementOverrides(response.headers);
        response.headers.set(name, value);
      }
    }
    return response;
  };
}
