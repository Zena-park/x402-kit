/**
 * Seller-side hardening:
 *   - one signed payment buys ONE delivery (replay guard), in every settle mode
 *   - a payment for another resource is refused
 *   - an oversized header is refused before decoding
 *   - a facilitator outage is a 503, never a 500 / unhandled rejection
 *   - capture() never rejects; failures reach onSettled
 *   - a non-boolean `isValid` / `success` never reads as paid
 *   - schedules: horizon bound, settled-entry exclusion
 */

import { describe, expect, it, vi } from "vitest";
import {
  ErrorReason,
  ErrorReasonExtra,
  HEADER_PAYMENT_SIGNATURE,
  decodePaymentRequired,
  encodePaymentPayload,
  exactScheme,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@x402.kit/core";
import { privateKeyToAccount } from "viem/accounts";
import { signPaymentSchedule } from "@x402.kit/buyer";
import {
  FacilitatorClient,
  FacilitatorUnreachableError,
  createPaywall,
  dueEntries,
  scheduleEntryId,
  validateSchedule,
  withGate,
} from "../src/index.js";

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

function payloadWithNonce(nonce: string, resource?: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: terms,
    ...(resource ? { resource: { url: resource } } : {}),
    payload: { signature: "0xabc", authorization: { from: PAYER, nonce } },
  };
}

const okVerify: VerifyResponse = { isValid: true, payer: PAYER };
const okSettle: SettleResponse = { success: true, transaction: `0x${"11".repeat(32)}`, network: terms.network };
const failSettle: SettleResponse = { success: false, errorReason: ErrorReason.INSUFFICIENT_FUNDS, transaction: "", network: terms.network };

function facilitator(verify: VerifyResponse | (() => Promise<VerifyResponse>), settle: SettleResponse | (() => Promise<SettleResponse>)) {
  return {
    verify: vi.fn(async (_r: FacilitatorRequest) => (typeof verify === "function" ? verify() : verify)),
    settle: vi.fn(async (_r: FacilitatorRequest) => (typeof settle === "function" ? settle() : settle)),
  };
}

const req = (payload: PaymentPayload, url = "http://shop.local/premium") =>
  new Request(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(payload) } });

async function reasonOf(decision: Awaited<ReturnType<ReturnType<typeof createPaywall>["check"]>>): Promise<string | undefined> {
  if (decision.paid) return undefined;
  return (await decision.response.json()).error;
}

describe("replay guard", () => {
  for (const mode of ["async", "after-handler", "none", "sync"] as const) {
    it(`${mode}: the same header presented twice is served once`, async () => {
      const f = facilitator(okVerify, okSettle);
      const pw = createPaywall({ accepts: [terms], facilitator: f, settle: mode, onVerified: () => {} });
      const payload = payloadWithNonce(`0x${"01".repeat(32)}`);
      const [a, b] = await Promise.all([pw.check(req(payload)), pw.check(req(payload))]);
      expect([a.paid, b.paid].filter(Boolean)).toHaveLength(1);
      const loser = a.paid ? b : a;
      expect(await reasonOf(loser)).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
      expect(f.verify).toHaveBeenCalledTimes(1); // the replay never reaches the facilitator
    });
  }

  it("two paywalls with identical terms share the default store — a header paid to /a is refused by /b", async () => {
    const f = facilitator(okVerify, okSettle);
    const a = createPaywall({ accepts: [terms], facilitator: f, settle: "none", onVerified: () => {} });
    const b = createPaywall({ accepts: [terms], facilitator: f, settle: "none", onVerified: () => {} });
    const payload = payloadWithNonce(`0x${"07".repeat(32)}`);
    expect((await a.check(req(payload))).paid).toBe(true);
    expect(await reasonOf(await b.check(req(payload)))).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  });

  it("an onVerified that throws releases the claim and answers 503, never a 500", async () => {
    const f = facilitator(okVerify, okSettle);
    let boom = true;
    const pw = createPaywall({ accepts: [terms], facilitator: f, onVerified: () => { if (boom) throw new Error("hook"); } });
    const payload = payloadWithNonce(`0x${"08".repeat(32)}`);
    const first = await pw.check(req(payload));
    expect(first.paid).toBe(false);
    expect(!first.paid && first.response.status).toBe(503);
    boom = false;
    expect((await pw.check(req(payload))).paid).toBe(true); // claim was released
  });

  it("a claim is released when verify rejects, so a corrected retry is not locked out", async () => {
    const f = facilitator({ isValid: false, invalidReason: ErrorReason.INSUFFICIENT_FUNDS }, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const payload = payloadWithNonce(`0x${"02".repeat(32)}`);
    expect(await reasonOf(await pw.check(req(payload)))).toBe(ErrorReason.INSUFFICIENT_FUNDS);
    f.verify.mockResolvedValueOnce(okVerify);
    expect((await pw.check(req(payload))).paid).toBe(true);
  });

  it("a claim is released when the settlement definitively fails (sync)", async () => {
    const f = facilitator(okVerify, failSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const payload = payloadWithNonce(`0x${"03".repeat(32)}`);
    expect(await reasonOf(await pw.check(req(payload)))).toBe(ErrorReason.INSUFFICIENT_FUNDS);
    f.settle.mockResolvedValueOnce(okSettle);
    expect((await pw.check(req(payload))).paid).toBe(true);
  });

  it("a pending settlement keeps the claim — the tx may still land", async () => {
    const pending: SettleResponse = { ...failSettle, errorReason: ErrorReasonExtra.SETTLEMENT_PENDING, transaction: okSettle.transaction };
    const f = facilitator(okVerify, pending);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const payload = payloadWithNonce(`0x${"04".repeat(32)}`);
    expect(await reasonOf(await pw.check(req(payload)))).toBe(ErrorReasonExtra.SETTLEMENT_PENDING);
    expect(await reasonOf(await pw.check(req(payload)))).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  });

  it("uses the scheme's paymentId — casing variants of one header are one claim", async () => {
    const f = facilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f, settle: "async" });
    const nonce = `0x${"0a".repeat(32)}`;
    const a = payloadWithNonce(nonce);
    const b = { ...a, payload: { ...a.payload, authorization: { from: PAYER.toLowerCase(), nonce: nonce.toUpperCase().replace("0X", "0x") } } };
    expect(exactScheme.paymentId(a, terms)).toBe(exactScheme.paymentId(b, terms));
    expect((await pw.check(req(a))).paid).toBe(true);
    expect((await pw.check(req(b))).paid).toBe(false);
  });

  it("replayStore: false disables the guard (sync only, operator's call)", async () => {
    const f = facilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f, replayStore: false });
    const payload = payloadWithNonce(`0x${"05".repeat(32)}`);
    expect((await pw.check(req(payload))).paid).toBe(true);
    expect((await pw.check(req(payload))).paid).toBe(true);
  });
});

describe("request hygiene", () => {
  it("refuses a payment whose resource.url names a different route", async () => {
    const f = facilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const elsewhere = payloadWithNonce(`0x${"06".repeat(32)}`, "http://shop.local/other");
    expect(await reasonOf(await pw.check(req(elsewhere)))).toBe(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
    const here = payloadWithNonce(`0x${"07".repeat(32)}`, "http://shop.local/premium");
    expect((await pw.check(req(here))).paid).toBe(true);
    expect(f.verify).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized PAYMENT-SIGNATURE header before decoding", async () => {
    const f = facilitator(okVerify, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const huge = new Request("http://shop.local/premium", { headers: { [HEADER_PAYMENT_SIGNATURE]: "A".repeat(9000) } });
    expect(await reasonOf(await pw.check(huge))).toBe(ErrorReason.INVALID_PAYLOAD);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it("echoes only known reason codes into the 402", async () => {
    const f = facilitator({ isValid: false, invalidReason: "<script>alert(1)</script>" }, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    const decision = await pw.check(req(payloadWithNonce(`0x${"08".repeat(32)}`)));
    expect(decision.paid).toBe(false);
    if (!decision.paid) {
      const body = decodePaymentRequired(decision.response.headers.get("PAYMENT-REQUIRED")!);
      expect(body.error).toBe("payment invalid");
    }
  });

  it("a truthy non-boolean isValid/success never reads as paid", async () => {
    const f = facilitator({ isValid: "false" as unknown as boolean }, okSettle);
    const pw = createPaywall({ accepts: [terms], facilitator: f });
    expect((await pw.check(req(payloadWithNonce(`0x${"09".repeat(32)}`)))).paid).toBe(false);
    const g = facilitator(okVerify, { ...okSettle, success: "no" as unknown as boolean });
    const pw2 = createPaywall({ accepts: [terms], facilitator: g });
    expect((await pw2.check(req(payloadWithNonce(`0x${"0b".repeat(32)}`)))).paid).toBe(false);
    const wrongChain = facilitator(okVerify, { ...okSettle, network: "eip155:1" });
    const pw3 = createPaywall({ accepts: [terms], facilitator: wrongChain });
    expect((await pw3.check(req(payloadWithNonce(`0x${"0c".repeat(32)}`)))).paid).toBe(false);
  });
});

describe("facilitator outage", () => {
  const down = () => Promise.reject(new FacilitatorUnreachableError("/verify"));

  it("check() answers 503 facilitator_unavailable instead of throwing", async () => {
    const pw = createPaywall({ accepts: [terms], facilitator: facilitator(down, okSettle) });
    const decision = await pw.check(req(payloadWithNonce(`0x${"0d".repeat(32)}`)));
    expect(decision.paid).toBe(false);
    if (!decision.paid) {
      expect(decision.response.status).toBe(503);
      expect(decision.response.headers.get("retry-after")).toBe("5");
    }
  });

  it("the node adapter writes the 503 and never leaves an unhandled rejection", async () => {
    const handler = vi.fn();
    const gate = withGate(createPaywall({ accepts: [terms], facilitator: facilitator(down, okSettle) }), handler);
    const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    await gate(
      { method: "GET", url: "/premium", headers: { [HEADER_PAYMENT_SIGNATURE.toLowerCase()]: encodePaymentPayload(payloadWithNonce(`0x${"0e".repeat(32)}`)) } },
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("after-handler capture() resolves with a failure and reports it via onSettled when settle throws", async () => {
    const onSettled = vi.fn();
    const f = facilitator(okVerify, () => Promise.reject(new FacilitatorUnreachableError("/settle")));
    const pw = createPaywall({ accepts: [terms], facilitator: f, settle: "after-handler", onSettled });
    const decision = await pw.check(req(payloadWithNonce(`0x${"0f".repeat(32)}`)));
    expect(decision.paid).toBe(true);
    if (decision.paid) {
      const { header, settlement } = await decision.capture!();
      expect(header).toBeUndefined();
      expect(settlement.success).toBe(false);
      expect(onSettled).toHaveBeenCalledWith(settlement, expect.anything());
    }
  });
});

describe("FacilitatorClient", () => {
  it("builds endpoints without query/fragment bleed-through and sends the API key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }));
    const client = new FacilitatorClient("https://f.example/api?x=1#frag", { fetchImpl, apiKey: "k" });
    await client.verify({} as FacilitatorRequest);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://f.example/api/verify");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("rejects a malformed response shape as unreachable rather than returning it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ isValid: "true" }), { status: 200 }));
    const client = new FacilitatorClient("https://f.example", { fetchImpl });
    await expect(client.verify({} as FacilitatorRequest)).rejects.toBeInstanceOf(FacilitatorUnreachableError);
  });

  it("warns on plain http to a non-loopback host unless allowInsecure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new FacilitatorClient("http://f.internal");
    expect(warn).toHaveBeenCalledTimes(1);
    new FacilitatorClient("http://127.0.0.1:4021");
    new FacilitatorClient("http://f.internal", { allowInsecure: true });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("schedules", () => {
  const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const p2: PaymentRequirements = { ...terms, extra: { assetTransferMethod: "permit2" } };
  const NOW = 1_800_000_000;
  const MONTH = 30 * 86_400;

  it("rejects a schedule reaching past the horizon, and one that already ended", async () => {
    const far = await signPaymentSchedule(p2, { signer, assets: [p2.asset], periods: { start: NOW, periodSeconds: MONTH, count: 3 }, maxTotalAmount: "30000" });
    const plain = JSON.parse(JSON.stringify(far));
    expect(validateSchedule(plain, [p2], { now: NOW }).ok).toBe(true);
    expect(validateSchedule(plain, [p2], { now: NOW, maxHorizonSeconds: MONTH }).error).toMatch(/horizon/);
    expect(validateSchedule(plain, [p2], { now: NOW + 4 * MONTH }).error).toMatch(/already closed/);
  });

  it("dueEntries skips installments the caller has recorded as settled", async () => {
    const signed = await signPaymentSchedule(p2, { signer, assets: [p2.asset], periods: { start: NOW, periodSeconds: MONTH, count: 2 }, maxTotalAmount: "20000" });
    const entries = validateSchedule(JSON.parse(JSON.stringify(signed)), [p2], { now: NOW });
    if (!entries.ok) throw new Error(entries.error);
    const due = dueEntries(entries.value, NOW + 60);
    expect(due).toHaveLength(1);
    const settled = new Set([scheduleEntryId(due[0]!)]);
    expect(dueEntries(entries.value, NOW + 60, { isSettled: (id) => settled.has(id) })).toHaveLength(0);
  });
});
