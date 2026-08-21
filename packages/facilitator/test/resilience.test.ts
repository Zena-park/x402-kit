/**
 * Resilience tests — does the facilitator stay correct when a server or an
 * intermediary dies or loses connectivity mid-operation?
 *
 * The design premise is "the chain is the source of truth; the in-memory cache
 * is only an optimization". These tests pin that premise:
 *
 *   - concurrent duplicate settles collapse to ONE on-chain submission
 *   - a process restart (fresh cache) never causes a double settle — the
 *     scheme's own guard (on-chain nonce / period) still holds
 *   - a broadcast-but-unconfirmed tx (RPC died mid-settle) is reported PENDING
 *     and its cache entry is RETAINED, so a retry never resubmits
 *   - a definite failure is evicted so a legitimate retry is allowed
 *   - a thrown settle (crash in the handler) never poisons the cache
 *
 * These use a mock scheme handler so they exercise the facilitator's caching
 * and lifecycle logic deterministically, without a chain.
 */

import { describe, expect, it, vi } from "vitest";
import { ErrorReasonExtra, type AnySchemeHandler, type FacilitatorRequest, type SettleResponse } from "@x402kit/core";
import { createFacilitator } from "../src/facilitator.js";
import type { ResolvedConfig } from "../src/config.js";

const NETWORK = "eip155:31337" as const;
const ASSET = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";

function config(): ResolvedConfig {
  return {
    port: 4021,
    signerKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    chains: [{ network: NETWORK, rpcUrl: "http://127.0.0.1:8545", tokens: "*" }],
  };
}

/** A scheme whose verify/settle are fully controllable, counting on-chain "submissions". */
function mockScheme(settleImpl: () => Promise<SettleResponse>): AnySchemeHandler & { settle: ReturnType<typeof vi.fn> } {
  const settle = vi.fn(settleImpl);
  return {
    scheme: "mock",
    networks: ["eip155:*"],
    paymentId: (p: { payload: { authorization: { from: string; nonce: string } } }) =>
      `${p.payload.authorization.from}:${p.payload.authorization.nonce}`,
    buildPayload: async () => ({}) as never,
    verify: async () => ({ isValid: true, payer: PAYER }),
    settle,
  } as unknown as AnySchemeHandler & { settle: ReturnType<typeof vi.fn> };
}

function request(nonce: string, amount = "1000"): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: { scheme: "mock", network: NETWORK, amount, asset: ASSET, payTo: PAYER, maxTimeoutSeconds: 60 },
      payload: { signature: "0xabc", authorization: { from: PAYER, nonce } },
    } as never,
    paymentRequirements: { scheme: "mock", network: NETWORK, amount, asset: ASSET, payTo: PAYER, maxTimeoutSeconds: 60 },
  };
}

const ok = (tx: string): SettleResponse => ({ success: true, transaction: `0x${tx}`, network: NETWORK, payer: PAYER });

describe("facilitator resilience", () => {
  it("collapses concurrent duplicate settles into ONE on-chain submission", async () => {
    let submissions = 0;
    const scheme = mockScheme(async () => {
      submissions++;
      await new Promise((r) => setTimeout(r, 20)); // simulate the confirm wait
      return ok("aa");
    });
    const f = createFacilitator(config(), [scheme]);

    // 5 concurrent identical settles (e.g. an impatient client / retry storm)
    const results = await Promise.all(Array.from({ length: 5 }, () => f.settle(request("0xnonce1"))));

    expect(submissions).toBe(1); // only one tx broadcast
    expect(scheme.settle).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.transaction).toBe("0xaa"); // all callers get the real result
  });

  it("a process restart (fresh cache) does not double-submit — the scheme's guard holds", async () => {
    // First "process": settles nonce1 successfully.
    const scheme1 = mockScheme(async () => ok("aa"));
    const f1 = createFacilitator(config(), [scheme1]);
    await f1.settle(request("0xnonce1"));

    // Restart: brand new facilitator, empty cache. The SAME payment arrives
    // again (client retried after the first process died before responding).
    // The scheme now reflects on-chain reality: the nonce is consumed.
    const scheme2 = mockScheme(async () => ({
      success: false,
      errorReason: ErrorReasonExtra.AUTHORIZATION_ALREADY_USED,
      transaction: "",
      network: NETWORK,
      payer: PAYER,
    }));
    const f2 = createFacilitator(config(), [scheme2]);
    const retry = await f2.settle(request("0xnonce1"));

    expect(retry.success).toBe(false);
    expect(retry.errorReason).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
    // No double spend: the second process relied on-chain, not on a lost cache.
  });

  it("retains the cache entry on a PENDING settle so a retry never resubmits", async () => {
    let submissions = 0;
    const scheme = mockScheme(async () => {
      submissions++;
      return { success: false, errorReason: ErrorReasonExtra.SETTLEMENT_PENDING, transaction: "0xdead", network: NETWORK, payer: PAYER };
    });
    const f = createFacilitator(config(), [scheme]);

    const first = await f.settle(request("0xnonce1"));
    expect(first.errorReason).toBe(ErrorReasonExtra.SETTLEMENT_PENDING);

    // A retry within the window must NOT resubmit — the broadcast tx may land.
    const retry = await f.settle(request("0xnonce1"));
    expect(submissions).toBe(1); // still one submission
    expect(retry.transaction).toBe("0xdead"); // same pending tx returned
  });

  it("evicts a definite failure so a legitimate retry is allowed", async () => {
    let attempt = 0;
    const scheme = mockScheme(async () => {
      attempt++;
      // First attempt fails definitively (e.g. transient RPC read error before broadcast);
      // second attempt succeeds.
      return attempt === 1
        ? { success: false, errorReason: "invalid_transaction_state", transaction: "", network: NETWORK, payer: PAYER }
        : ok("bb");
    });
    const f = createFacilitator(config(), [scheme]);

    const first = await f.settle(request("0xnonce1"));
    expect(first.success).toBe(false);

    const retry = await f.settle(request("0xnonce1"));
    expect(retry.success).toBe(true); // not stuck on the cached failure
    expect(scheme.settle).toHaveBeenCalledTimes(2);
  });

  it("a thrown settle (handler crash) never poisons the cache", async () => {
    let attempt = 0;
    const scheme = mockScheme(async () => {
      attempt++;
      if (attempt === 1) throw new Error("RPC connection reset mid-settle");
      return ok("cc");
    });
    const f = createFacilitator(config(), [scheme]);

    await expect(f.settle(request("0xnonce1"))).rejects.toThrow(/connection reset/);

    // The rejected promise must have been evicted — a retry runs fresh, not
    // a permanently cached rejection.
    const retry = await f.settle(request("0xnonce1"));
    expect(retry.transaction).toBe("0xcc");
  });

  it("a fresh signature (new nonce) is a NEW payment — an unsigned identifier cannot dedupe it", async () => {
    // The dedup key is the SIGNED on-chain nonce, never a wire-supplied
    // identifier. This is the HIGH-2 fix: trusting an unsigned paymentIdentifier
    // let one payment be replayed as "already settled" for many deliveries.
    let submissions = 0;
    const scheme = mockScheme(async () => {
      submissions++;
      return ok("aa");
    });
    // The real exact paymentId: on-chain (from, nonce) only, identifier ignored.
    (scheme as { paymentId: unknown }).paymentId = (p: { payload: { authorization: { from: string; nonce: string } } }) =>
      `${p.payload.authorization.from}:${p.payload.authorization.nonce}`;
    const f = createFacilitator(config(), [scheme]);

    const withId = (nonce: string): FacilitatorRequest => {
      const r = request(nonce);
      // Even if a client still sends one, it must have NO effect on dedup.
      (r.paymentPayload as { extensions?: unknown }).extensions = { paymentIdentifier: "order-2026-08-20-0001" };
      return r;
    };

    await f.settle(withId("0xnonceA"));
    await f.settle(withId("0xnonceB")); // fresh nonce → genuinely a second payment

    expect(submissions).toBe(2); // NOT deduped — the unsigned identifier is powerless
  });

  it("the same signature resubmitted collapses to one settlement (honest dedup on the signed nonce)", async () => {
    let submissions = 0;
    const scheme = mockScheme(async () => {
      submissions++;
      return ok("aa");
    });
    const f = createFacilitator(config(), [scheme]);

    // Same payload (same nonce) sent twice — the legitimate retry case.
    const first = await f.settle(request("0xsameNonce"));
    const retry = await f.settle(request("0xsameNonce"));

    expect(submissions).toBe(1); // deduped on the signed nonce
    expect(retry.transaction).toBe(first.transaction);
  });

  it("distinct payments sharing a nonce never collide onto one result", async () => {
    // The classic bug: key on (from, nonce) only. Two different payTo/amount
    // under one nonce must settle independently.
    // return a tx derived from the amount so the two are distinguishable
    const scheme = mockScheme(async () => ok("00"));
    (scheme.settle as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: unknown, reqs: { amount: string }) => ok(reqs.amount),
    );
    // Override paymentId to the vulnerable (from:nonce) form to prove the
    // facilitator's full-terms + payload-hash key still separates them.
    (scheme as { paymentId: unknown }).paymentId = () => `${PAYER}:sharedNonce`;
    const f = createFacilitator(config(), [scheme]);

    const a = request("0xshared", "1000");
    const b = request("0xshared", "999999"); // different amount → different terms
    const [ra, rb] = await Promise.all([f.settle(a), f.settle(b)]);

    expect(scheme.settle).toHaveBeenCalledTimes(2); // NOT collapsed
    expect(ra.transaction).toBe("0x1000");
    expect(rb.transaction).toBe("0x999999");
  });
});
