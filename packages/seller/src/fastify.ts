/**
 * Fastify adapter. Typed structurally so fastify is not a dependency — it
 * reuses the node:http conversion (`request.raw` is an IncomingMessage,
 * `reply.raw` a ServerResponse).
 *
 *   import { paywall } from "@x402.kit/seller/fastify";
 *   fastify.addHook("preHandler", paywall({ accepts: [...], facilitator: "https://…" }));
 *   // or per-route: { preHandler: paywall({...}) }
 *
 * On no/invalid payment the hook writes the 402 itself and hijacks the reply,
 * so the route handler never runs. On success it sets PAYMENT-RESPONSE and
 * lets fastify continue.
 */

import { HEADER_PAYMENT_RESPONSE } from "@x402.kit/core";
import { applyDecision, requestFromNode, type NodeRequestLike, type NodeResponseLike } from "./node.js";
import { createPaywall, type Paywall, type PaywallOptions } from "./paywall.js";

interface FastifyRequestLike {
  raw: NodeRequestLike;
}

interface FastifyReplyLike {
  raw: NodeResponseLike;
  header(name: string, value: string): unknown;
  /** Take over the reply — fastify will not send anything after this */
  hijack(): unknown;
}

type FastifyPreHandler = (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>;

export function paywall(options: PaywallOptions): FastifyPreHandler {
  const pw: Paywall = createPaywall(options);
  return async (request, reply) => {
    const decision = await pw.check(requestFromNode(request.raw));
    if (decision.paid) {
      for (const [name, value] of Object.entries(decision.responseHeaders)) {
        reply.header(name, value);
      }
      // A preHandler runs before the route handler, so "after-handler" settles
      // here (sync) rather than being silently skipped. The header attaches
      // because the handler has not produced the response yet.
      if (decision.capture) {
        const { header } = await decision.capture();
        if (header) reply.header(HEADER_PAYMENT_RESPONSE, header);
      }
      return;
    }
    // Unpaid — send the 402 ourselves and stop fastify from continuing.
    reply.hijack();
    await applyDecision(reply.raw, decision);
  };
}
