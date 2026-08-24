/**
 * POS preset — in-person authorize/capture over any channel (QR · NFC · BLE).
 *
 *   import { createPosTerminal } from "@x402.kit/seller/pos";
 *   const pos = createPosTerminal({ facilitator: "https://…" });
 *
 *   const order = pos.order(permit2Terms({ …, amount: "3200000000" }),
 *                           { url: "pos://lane-1/order-42" });
 *   show(order.qr);                                  // 402 terms as a QR
 *   const auth = await order.authorize(wireFromPhone); // free, instant — AUTHORIZE
 *   if (auth.authorized) {
 *     handOverTheGoods();
 *     await auth.capture();                          // on-chain — CAPTURE, off the critical path
 *   }
 *
 * What this adds over driving the facilitator by hand (the old recipe):
 * the paywall core's replay guard (the same signature presented at two lanes
 * authorizes ONCE), the terms-echo check, malformed-payload safety, and
 * upto's capture({ amount }) — tips and metered charges included.
 *
 * To VOID an authorized order, simply never call capture() — nothing has
 * touched the chain, and the replay claim expires with the terms' validity.
 */

import {
  encodePaymentRequired,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "@x402.kit/core";
import { MAX_PAYMENT_HEADER_BYTES, createPaywall, type CaptureOptions, type PaywallOptions } from "./paywall.js";

export interface PosTerminalOptions
  extends Pick<PaywallOptions, "facilitator" | "schemes" | "replayStore" | "onSettled" | "onVerified"> {}

export type PosAuthorization =
  | { authorized: false; reason: string }
  | {
      authorized: true;
      /**
       * CAPTURE — settle on-chain, off the customer's critical path. `amount`
       * charges less than the signed figure (upto: metered charges, tips-down;
       * fixed-amount schemes ignore it). Never rejects: check `success` on the
       * returned settlement. Calling it again returns the first result.
       */
      capture(opts?: CaptureOptions): Promise<SettleResponse>;
    };

export interface PosOrder {
  /** The 402 terms, wire-encoded — put this in the QR / NFC record */
  qr: string;
  /** The same terms as an object, for terminals that render their own UI */
  paymentRequired: PaymentRequired;
  /**
   * AUTHORIZE — free, instant, no chain writes. `wire` is the encoded payload
   * the phone sends back over whatever channel the terminal offers. A replayed
   * or malformed payload, terms that were never offered, or a facilitator
   * outage all come back as `{ authorized: false, reason }` — never a throw.
   */
  authorize(wire: string): Promise<PosAuthorization>;
}

export interface PosTerminal {
  /** One order = one terms object (the amount of this sale) + its receipt line */
  order(terms: PaymentRequirements, resource: ResourceInfo): PosOrder;
}

export function createPosTerminal(options: PosTerminalOptions): PosTerminal {
  return {
    order(terms, resource) {
      // One paywall per order: terms are validated at creation (a mistyped
      // amount fails at the counter's build step, not at the customer's scan),
      // and the replay store stays process-wide so sibling lanes share claims.
      const paywall = createPaywall({ ...options, accepts: [terms], resource, settle: "after-handler" });
      const paymentRequired: PaymentRequired = { x402Version: 2, resource, accepts: [terms] };

      return {
        qr: encodePaymentRequired(paymentRequired),
        paymentRequired,

        async authorize(wire) {
          // The wire payload is the HTTP header's bytes on a different
          // channel: same size guard, same base64+JSON decode, then straight
          // into the transport-free protocol core.
          let payment: unknown = null; // null fails schema validation → invalid_payload
          if (typeof wire === "string" && wire.length > 0 && wire.length <= MAX_PAYMENT_HEADER_BYTES) {
            try {
              payment = JSON.parse(Buffer.from(wire, "base64").toString("utf8"));
            } catch {
              /* stays null */
            }
          }
          const decision = await paywall.checkPayment(payment, resource);
          if (!decision.paid) {
            return {
              authorized: false,
              reason:
                decision.status === 503
                  ? "facilitator_unavailable"
                  : (decision.paymentRequired.error ?? "payment invalid"),
            };
          }
          const capture = decision.capture!; // settle: "after-handler" always supplies it
          return {
            authorized: true,
            capture: async (opts?: CaptureOptions) => (await capture(opts)).settlement,
          };
        },
      };
    },
  };
}
