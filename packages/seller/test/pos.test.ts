import { describe, expect, it, vi } from "vitest";
import {
  decodePaymentRequired,
  encodePaymentPayload,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { FacilitatorUnreachableError } from "../src/client.js";
import { createPosTerminal } from "../src/pos.js";

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "3200000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: terms,
  payload: { signature: "0xabc", authorization: { nonce: "0x01" } },
};

const okVerify: VerifyResponse = { isValid: true, payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66" };
const okSettle: SettleResponse = { success: true, transaction: `0x${"11".repeat(32)}`, network: terms.network };

function fakeFacilitator(verify: VerifyResponse | Error = okVerify, settle: SettleResponse | Error = okSettle) {
  return {
    verify: vi.fn(async (_req: FacilitatorRequest) => {
      if (verify instanceof Error) throw verify;
      return verify;
    }),
    settle: vi.fn(async (_req: FacilitatorRequest) => {
      if (settle instanceof Error) throw settle;
      return settle;
    }),
  };
}

const resource = { url: "pos://lane-1/order-42" };
const wire = () => encodePaymentPayload(payload);

describe("createPosTerminal", () => {
  it("presents the terms as a QR and authorizes without touching the chain", async () => {
    const facilitator = fakeFacilitator();
    const order = createPosTerminal({ facilitator }).order(terms, resource);

    expect(decodePaymentRequired(order.qr)).toEqual(order.paymentRequired);
    expect(order.paymentRequired.accepts).toEqual([terms]);
    expect(order.paymentRequired.resource).toEqual(resource);

    const auth = await order.authorize(wire());
    expect(auth.authorized).toBe(true);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).not.toHaveBeenCalled(); // authorize is capture-free
  });

  it("capture settles once — a second capture returns the first result", async () => {
    const facilitator = fakeFacilitator();
    const order = createPosTerminal({ facilitator }).order(terms, resource);
    const auth = await order.authorize(wire());
    if (!auth.authorized) throw new Error("expected authorized");

    expect(await auth.capture()).toEqual(okSettle);
    expect(await auth.capture()).toEqual(okSettle);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("the same wire presented at two lanes authorizes once (shared replay guard)", async () => {
    const facilitator = fakeFacilitator();
    const pos = createPosTerminal({ facilitator });
    const laneOne = pos.order(terms, resource);
    const laneTwo = pos.order(terms, { url: "pos://lane-2/order-42" });

    const first = await laneOne.authorize(wire());
    const second = await laneTwo.authorize(wire());
    expect(first.authorized).toBe(true);
    expect(second.authorized).toBe(false);
    if (second.authorized) return;
    expect(second.reason).toBe("authorization_already_used");
  });

  it("refuses terms it never offered, malformed wires, and oversized wires without throwing", async () => {
    const facilitator = fakeFacilitator();
    const order = createPosTerminal({ facilitator }).order(terms, resource);

    const foreign = encodePaymentPayload({ ...payload, accepted: { ...terms, amount: "1" } });
    const echoed = await order.authorize(foreign);
    expect(echoed).toEqual({ authorized: false, reason: "invalid_payment_requirements" });

    expect(await order.authorize("not-base64-json")).toEqual({ authorized: false, reason: "invalid_payload" });
    expect(await order.authorize("")).toEqual({ authorized: false, reason: "invalid_payload" });
    expect(await order.authorize("A".repeat(9 * 1024))).toEqual({ authorized: false, reason: "invalid_payload" });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("a facilitator outage reads as facilitator_unavailable, not a throw", async () => {
    const facilitator = fakeFacilitator(new FacilitatorUnreachableError("down"));
    const order = createPosTerminal({ facilitator }).order(terms, resource);
    expect(await order.authorize(wire())).toEqual({ authorized: false, reason: "facilitator_unavailable" });
  });

  it("a failed settlement surfaces through capture's result and onSettled", async () => {
    const failed: SettleResponse = { success: false, errorReason: "insufficient_funds", transaction: "", network: terms.network };
    const onSettled = vi.fn();
    const order = createPosTerminal({ facilitator: fakeFacilitator(okVerify, failed), onSettled }).order(terms, resource);
    const auth = await order.authorize(wire());
    if (!auth.authorized) throw new Error("expected authorized");

    expect((await auth.capture()).success).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(failed, expect.anything());
  });
});
