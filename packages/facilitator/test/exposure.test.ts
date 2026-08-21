/**
 * Exposure controls — what keeps a facilitator from being a free gas relay
 * and an RPC amplifier:
 *
 *   - operator terms policy: token floor (minAmount) and payTo scope
 *   - in-flight ceiling → settle_overloaded, nothing broadcast
 *   - coarse /health (no exact balances)
 *   - a pending entry reconciles on retry once a receipt exists
 *   - HTTP: API key (constant-time), per-IP rate limit, startup refusal
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ErrorReason, ErrorReasonExtra, type AnySchemeHandler, type FacilitatorRequest, type SettleResponse } from "@x402kit/core";
import { createFacilitator, type Facilitator } from "../src/facilitator.js";
import { assertSettleExposure, createRequestHandler } from "../src/server.js";
import type { ResolvedConfig } from "../src/config.js";

const NETWORK = "eip155:31337" as const;
const ASSET = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x3333333333333333333333333333333333333333";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function config(over: Partial<ResolvedConfig> = {}, tokens: ResolvedConfig["chains"][0]["tokens"] = "*"): ResolvedConfig {
  return {
    port: 4021,
    signerKey: KEY,
    chains: [{ network: NETWORK, rpcUrl: "http://127.0.0.1:8545", tokens }],
    ...over,
  };
}

function mockScheme(settleImpl: () => Promise<SettleResponse>): AnySchemeHandler {
  return {
    scheme: "mock",
    networks: ["eip155:*"],
    paymentId: (p: { payload: { authorization: { from: string; nonce: string } } }) =>
      `${p.payload.authorization.from}:${p.payload.authorization.nonce}`,
    buildPayload: async () => ({}) as never,
    verify: async () => ({ isValid: true, payer: PAYER }),
    settle: vi.fn(settleImpl),
  } as unknown as AnySchemeHandler;
}

function request(nonce: string, amount = "1000", payTo = SELLER): FacilitatorRequest {
  const reqs = { scheme: "mock", network: NETWORK, amount, asset: ASSET, payTo, maxTimeoutSeconds: 60 };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: reqs, payload: { signature: "0xabc", authorization: { from: PAYER, nonce } } } as never,
    paymentRequirements: reqs,
  };
}

const ok = (tx: string): SettleResponse => ({ success: true, transaction: `0x${tx}`, network: NETWORK, payer: PAYER });

describe("terms policy", () => {
  it("refuses amounts under the token's minAmount floor — a 1-wei self-transfer is not worth our gas", async () => {
    const scheme = mockScheme(async () => ok("aa"));
    const f = createFacilitator(config({}, [{ address: ASSET, name: "T", version: "1", minAmount: "500" }]), [scheme]);
    expect((await f.settle(request("0x1", "499"))).errorReason).toBe(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
    expect((await f.verify(request("0x1", "499"))).invalidReason).toBe(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
    expect((await f.settle(request("0x2", "500"))).success).toBe(true);
  });

  it("refuses recipients outside allowedPayTo — scoped to the operator's own sellers", async () => {
    const f = createFacilitator(config({ allowedPayTo: [SELLER] }), [mockScheme(async () => ok("aa"))]);
    expect((await f.settle(request("0x1", "1000", PAYER))).errorReason).toBe(ErrorReason.INVALID_PAYMENT_REQUIREMENTS);
    expect((await f.settle(request("0x2", "1000", SELLER.toLowerCase()))).success).toBe(true);
  });

  it("scrubs the signer key from the config object after deriving the account", () => {
    const c = config();
    createFacilitator(c, [mockScheme(async () => ok("aa"))]);
    expect(c.signerKey).not.toBe(KEY);
  });
});

describe("in-flight ceiling", () => {
  it("past maxInflightSettles new payments get settle_overloaded and are never broadcast", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const scheme = mockScheme(async () => {
      await gate;
      return ok("aa");
    });
    const f = createFacilitator(config({ maxInflightSettles: 2 }), [scheme]);
    const a = f.settle(request("0x1"));
    const b = f.settle(request("0x2"));
    const c = await f.settle(request("0x3"));
    expect(c.errorReason).toBe(ErrorReasonExtra.SETTLE_OVERLOADED);
    expect(scheme.settle).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([a, b]);
    // slots freed → accepted again
    expect((await f.settle(request("0x4"))).success).toBe(true);
  });
});

describe("pending reconciliation", () => {
  it("a retry against a pending entry resolves to success once the receipt exists", async () => {
    const scheme = mockScheme(async () => ({
      success: false,
      errorReason: ErrorReasonExtra.SETTLEMENT_PENDING,
      transaction: `0x${"ab".repeat(32)}`,
      network: NETWORK,
      payer: PAYER,
    }));
    const f = createFacilitator(config(), [scheme]);
    const first = await f.settle(request("0x1"));
    expect(first.errorReason).toBe(ErrorReasonExtra.SETTLEMENT_PENDING);
    // reach into the public client via the scheme's ctx: stub getTransactionReceipt
    const ctx = (scheme.settle as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { publicClient: Record<string, unknown> };
    ctx.publicClient.getTransactionReceipt = async () => ({ status: "success" });
    const second = await f.settle(request("0x1"));
    expect(second.success).toBe(true);
    expect(second.errorReason).toBeUndefined();
    expect(scheme.settle).toHaveBeenCalledTimes(1); // never resubmitted
  });
});

describe("/health", () => {
  it("reports coarse status, never raw balances", async () => {
    const scheme = mockScheme(async () => ok("aa"));
    const f = createFacilitator(config(), [scheme]);
    const h = await f.health();
    expect(Object.values(h.gas).every((v) => ["ok", "empty", "unreachable"].includes(v))).toBe(true);
  });
});

// ---- HTTP layer ----

function fakeReq(method: string, url: string, headers: Record<string, string> = {}, body?: unknown, ip = "10.0.0.1") {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json", ...headers };
  req.socket = { remoteAddress: ip };
  req.destroy = () => {};
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return req;
}

function fakeRes() {
  const res = { status: 0, headers: {} as Record<string, string>, body: "", done: undefined as Promise<void> | undefined };
  let resolve!: () => void;
  res.done = new Promise<void>((r) => (resolve = r));
  return Object.assign(res, {
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      Object.assign(res.headers, headers);
    },
    end(b: string) {
      res.body = b;
      resolve();
    },
  });
}

function facilitatorStub(): Facilitator {
  return {
    verify: async () => ({ isValid: true }),
    settle: async () => ok("aa"),
    supported: () => ({ kinds: [], extensions: [], signers: {} }),
    health: async () => ({ ok: true, gas: {} }),
    assertChainIds: async () => {},
    signerAddress: PAYER,
  };
}

describe("HTTP exposure", () => {
  it("refuses to start an open /settle unless the operator says so", () => {
    expect(() => assertSettleExposure(config())).toThrow(/unauthenticatedSettle/);
    expect(() => assertSettleExposure(config({ settleApiKey: "k" }))).not.toThrow();
    expect(() => assertSettleExposure(config({ allowedPayTo: [SELLER] }))).not.toThrow();
    expect(() => assertSettleExposure(config({ unauthenticatedSettle: true }))).not.toThrow();
  });

  it("requires the API key on POST /settle and /verify when configured", async () => {
    const handle = createRequestHandler(facilitatorStub(), config({ settleApiKey: "s3cret" }));
    const denied = fakeRes();
    handle(fakeReq("POST", "/settle", {}, request("0x1")) as never, denied as never);
    await denied.done;
    expect(denied.status).toBe(401);

    const wrong = fakeRes();
    handle(fakeReq("POST", "/verify", { authorization: "Bearer nope" }, request("0x1")) as never, wrong as never);
    await wrong.done;
    expect(wrong.status).toBe(401);

    const allowed = fakeRes();
    handle(fakeReq("POST", "/settle", { "x-api-key": "s3cret" }, request("0x1")) as never, allowed as never);
    await allowed.done;
    expect(allowed.status).toBe(200);
  });

  it("an unauthenticated flood cannot exhaust the bucket of a caller holding the API key", async () => {
    const handle = createRequestHandler(facilitatorStub(), config({ rateLimitPerMinute: 2, settleApiKey: "k" }));
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      handle(fakeReq("POST", "/verify", {}, request("0x1")) as never, res as never); // no key
      await res.done;
      expect([401, 429]).toContain(res.status);
    }
    const ok = fakeRes();
    handle(fakeReq("POST", "/verify", { authorization: "Bearer k" }, request("0x1")) as never, ok as never);
    await ok.done;
    expect(ok.status).toBe(200);
  });

  it("with trustProxy the first x-forwarded-for hop is the rate-limit key; without it the header is ignored", async () => {
    const proxied = createRequestHandler(facilitatorStub(), config({ unauthenticatedSettle: true, rateLimitPerMinute: 1, trustProxy: true }));
    const a = fakeRes();
    proxied(fakeReq("POST", "/verify", { "x-forwarded-for": "1.1.1.1, 10.0.0.1" }, request("0x1")) as never, a as never);
    await a.done;
    const b = fakeRes();
    proxied(fakeReq("POST", "/verify", { "x-forwarded-for": "2.2.2.2, 10.0.0.1" }, request("0x1")) as never, b as never);
    await b.done;
    expect([a.status, b.status]).toEqual([200, 200]); // distinct clients behind one socket address

    const direct = createRequestHandler(facilitatorStub(), config({ unauthenticatedSettle: true, rateLimitPerMinute: 1 }));
    const c = fakeRes();
    direct(fakeReq("POST", "/verify", { "x-forwarded-for": "1.1.1.1" }, request("0x1")) as never, c as never);
    await c.done;
    const d = fakeRes();
    direct(fakeReq("POST", "/verify", { "x-forwarded-for": "2.2.2.2" }, request("0x1")) as never, d as never);
    await d.done;
    expect([c.status, d.status]).toEqual([200, 429]); // spoofed header does not buy a fresh bucket
  });

  it("rate-limits a single client IP with 429 + retry-after", async () => {
    const handle = createRequestHandler(facilitatorStub(), config({ unauthenticatedSettle: true, rateLimitPerMinute: 2 }));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = fakeRes();
      handle(fakeReq("POST", "/verify", {}, request("0x1")) as never, res as never);
      await res.done;
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const other = fakeRes();
    handle(fakeReq("POST", "/verify", {}, request("0x1"), "10.0.0.2") as never, other as never);
    await other.done;
    expect(other.status).toBe(200); // a different client has its own bucket
  });

  it("maps settle_overloaded to 503 + retry-after", async () => {
    const f = { ...facilitatorStub(), settle: async () => ({ success: false, errorReason: ErrorReasonExtra.SETTLE_OVERLOADED, transaction: "" as const, network: NETWORK }) };
    const handle = createRequestHandler(f, config({ unauthenticatedSettle: true }));
    const res = fakeRes();
    handle(fakeReq("POST", "/settle", {}, request("0x1")) as never, res as never);
    await res.done;
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
  });
});
