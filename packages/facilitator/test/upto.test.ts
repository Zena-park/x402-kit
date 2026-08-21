/**
 * Facilitator × upto: /supported advertises the facilitator address buyers
 * must bind, and settle idempotency ignores the amount for phase-dependent
 * schemes (one authorization, one settlement, whatever figure is asked).
 */

import { describe, expect, it, vi } from "vitest";
import type { AnySchemeHandler, FacilitatorRequest, SettleResponse } from "@x402kit/core";
import { createFacilitator } from "../src/facilitator.js";
import type { ResolvedConfig } from "../src/config.js";

const NETWORK = "eip155:31337" as const;
const ASSET = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";

function config(): ResolvedConfig {
  return {
    port: 4021,
    signerKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    chains: [{ network: NETWORK, rpcUrl: "http://127.0.0.1:8545", tokens: [{ address: ASSET, name: "T", version: "1" }] }],
  };
}

describe("/supported", () => {
  it("advertises upto with extra.facilitatorAddress = the signer, next to the token allowlist", () => {
    const f = createFacilitator(config());
    const kinds = f.supported().kinds;
    const upto = kinds.find((k) => k.scheme === "upto");
    const exact = kinds.find((k) => k.scheme === "exact");
    expect(upto?.extra).toEqual({ assets: [ASSET], facilitatorAddress: f.signerAddress });
    expect(exact?.extra).toEqual({ assets: [ASSET] });
  });
});

describe("settle idempotency for a phase-dependent amount", () => {
  function phaseScheme(): AnySchemeHandler & { settle: ReturnType<typeof vi.fn> } {
    const settle = vi.fn(async (_p: unknown, reqs: { amount: string }): Promise<SettleResponse> => ({
      success: true,
      transaction: `0x${reqs.amount}`,
      network: NETWORK,
      payer: PAYER,
      amount: reqs.amount,
    }));
    return {
      scheme: "mockupto",
      networks: ["eip155:*"],
      phaseDependentAmount: true,
      paymentId: () => `${PAYER}:nonce`,
      buildPayload: async () => ({}) as never,
      verify: async () => ({ isValid: true, payer: PAYER }),
      settle,
    } as unknown as AnySchemeHandler & { settle: ReturnType<typeof vi.fn> };
  }
  const request = (amount: string): FacilitatorRequest => {
    const terms = { scheme: "mockupto", network: NETWORK, amount, asset: ASSET, payTo: PAYER, maxTimeoutSeconds: 60 } as const;
    return {
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: { ...terms, amount: "10000" }, payload: { signature: "0xabc" } },
      paymentRequirements: terms,
    };
  };

  it("a second settle with a different amount returns the FIRST result — no second draw", async () => {
    const scheme = phaseScheme();
    const f = createFacilitator(config(), [scheme]);
    const first = await f.settle(request("4000"));
    const second = await f.settle(request("9000"));
    expect(scheme.settle).toHaveBeenCalledTimes(1);
    expect(first.amount).toBe("4000");
    expect(second).toEqual(first);
  });
});

describe("minAmount floor × phase-dependent amount", () => {
  it("judges the floor on the cap at verify AND on the actual at settle; only $0 is exempt", async () => {
    const scheme = {
      scheme: "mockupto",
      networks: ["eip155:*"],
      phaseDependentAmount: true,
      paymentId: () => `${PAYER}:n2`,
      buildPayload: async () => ({}) as never,
      verify: async () => ({ isValid: true, payer: PAYER }),
      settle: async (_p: unknown, reqs: { amount: string }): Promise<SettleResponse> => ({
        success: true,
        transaction: "",
        network: NETWORK,
        amount: reqs.amount,
      }),
    } as unknown as AnySchemeHandler;
    const cfg = config();
    (cfg.chains[0]!.tokens as { minAmount?: string }[])[0]!.minAmount = "1000";
    const f = createFacilitator(cfg, [scheme]);
    const terms = { scheme: "mockupto", network: NETWORK, asset: ASSET, payTo: PAYER, maxTimeoutSeconds: 60 } as const;
    const req = (amount: string): FacilitatorRequest => ({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: { ...terms, amount: "5000" }, payload: { signature: "0xabc" } },
      paymentRequirements: { ...terms, amount },
    });
    expect((await f.verify(req("999"))).isValid).toBe(false); // a cap under the floor is not worth the gas
    expect((await f.verify(req("5000"))).isValid).toBe(true);
    expect((await f.settle(req("0"))).success).toBe(true); // $0 actual — nothing to broadcast
    expect((await f.settle(req("1"))).success).toBe(false); // dust actual — not worth our gas
    expect((await f.settle(req("1000"))).success).toBe(true);
  });
});
