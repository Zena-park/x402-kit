/**
 * Express adapter. Typed structurally so express is not a dependency — plain
 * connect-style middlewares with the same shape work too.
 *
 *   import { paywall } from "@x402kit/seller/express";
 *   app.use("/premium", paywall({ accepts: [...], facilitator: "https://…" }));
 */

import { HEADER_PAYMENT_RESPONSE } from "@x402kit/core";
import { applyDecision, requestFromNode, type NodeRequestLike, type NodeResponseLike } from "./node.js";
import { createPaywall, type PaywallOptions } from "./paywall.js";

type ExpressishMiddleware = (
  req: NodeRequestLike,
  res: NodeResponseLike,
  next: (err?: unknown) => void,
) => void;

export function paywall(options: PaywallOptions): ExpressishMiddleware {
  const pw = createPaywall(options);
  return (req, res, next) => {
    void (async () => {
      const decision = await pw.check(requestFromNode(req));
      if (!(await applyDecision(res, decision))) return; // 402 already written
      // A hook middleware runs before the handler, so "after-handler" settles
      // here (sync) — the settlement must not be silently skipped. The header
      // still attaches because the handler has not sent the response yet.
      if (decision.paid && decision.capture) {
        const { header } = await decision.capture();
        if (header) res.setHeader(HEADER_PAYMENT_RESPONSE, header);
      }
      next();
    })().catch(next);
  };
}
