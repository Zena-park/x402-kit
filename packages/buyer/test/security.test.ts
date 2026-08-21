/**
 * Buyer-side hardening against a hostile seller:
 *   - maxTotalAmount bounds the SUM of everything a wrapper signs
 *   - terms that arrived via a redirect to another origin are never signed
 *   - schedules need an asset allowlist (same gate as wrapFetch)
 *   - the axios guard reads the browser's responseURL too
 */

import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  buildPaymentRequired,
  encodePaymentRequired,
  type PaymentRequirements,
} from "@x402kit/core";
import { signPaymentSchedule, wrapFetch } from "../src/index.js";
import { attachX402 } from "../src/axios.js";

const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

function r402(url = "http://api.local/premium", accepts: PaymentRequirements[] = [terms]): Response {
  const body = buildPaymentRequired({ resource: { url }, accepts });
  const res = new Response("{}", { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body) } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

describe("maxTotalAmount", () => {
  it("stops signing once the cumulative total would exceed the budget", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      input instanceof Request && input.headers.has(HEADER_PAYMENT_SIGNATURE) ? new Response("ok") : r402(),
    );
    const onSkipped = vi.fn();
    const paid = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      assets: [terms.asset],
      maxAmount: "10000",
      maxTotalAmount: "25000",
      onSkipped,
    });
    expect((await paid("http://api.local/premium")).status).toBe(200);
    expect((await paid("http://api.local/premium")).status).toBe(200);
    expect((await paid("http://api.local/premium")).status).toBe(402); // third would make 30000 > 25000
    expect(onSkipped).toHaveBeenCalledWith(expect.stringMatching(/maxTotalAmount/), expect.anything());
  });

  it("refunds the reservation when the paid retry never reaches the seller", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      if (input instanceof Request && input.headers.has(HEADER_PAYMENT_SIGNATURE)) {
        if (calls === 2) throw new TypeError("fetch failed");
        return new Response("ok");
      }
      return r402();
    });
    const paid = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, assets: [terms.asset], maxAmount: "10000", maxTotalAmount: "10000" });
    await expect(paid("http://api.local/premium")).rejects.toThrow(/fetch failed/);
    expect((await paid("http://api.local/premium")).status).toBe(200); // budget still intact
  });

  it("rejects a malformed budget at construction", () => {
    expect(() => wrapFetch(fetch, { signer, allowAnyAsset: true, maxAmount: "1", maxTotalAmount: "1e6" })).toThrow(/maxTotalAmount/);
  });
});

describe("origin binding before signing", () => {
  it("does not sign terms from a 402 that arrived via a redirect to another origin", async () => {
    const fetchImpl = vi.fn(async () => r402("http://evil.example/pay"));
    const onSkipped = vi.fn();
    const paid = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, allowAnyAsset: true, maxAmount: "10000", onSkipped });
    const res = await paid("http://api.local/premium");
    expect(res.status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no signature was ever produced or sent
    expect(onSkipped).toHaveBeenCalledWith(expect.stringMatching(/different origin/), expect.anything());
  });
});

describe("signPaymentSchedule policy", () => {
  const p2: PaymentRequirements = { ...terms, extra: { assetTransferMethod: "permit2" } };
  const periods = { start: 1_800_000_000, periodSeconds: 86_400 * 30, count: 2 };

  it("requires an asset allowlist unless allowAnyAsset", async () => {
    await expect(signPaymentSchedule(p2, { signer, periods, maxTotalAmount: "20000" })).rejects.toThrow(/assets/);
    await expect(signPaymentSchedule(p2, { signer, periods, maxTotalAmount: "20000", allowAnyAsset: true })).resolves.toHaveLength(2);
  });

  it("refuses terms naming a token or network outside the allowlist", async () => {
    const wbtc = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
    await expect(signPaymentSchedule(p2, { signer, periods, maxTotalAmount: "20000", assets: [wbtc] })).rejects.toThrow(/allowlist/);
    await expect(signPaymentSchedule(p2, { signer, periods, maxTotalAmount: "20000", assets: [p2.asset], networks: ["eip155:1"] })).rejects.toThrow(/network/);
  });

  it("a chain-scoped (CAIP-19) asset entry refuses the same address on another network", async () => {
    const scoped = [`${p2.network}/erc20:${p2.asset}`];
    await expect(signPaymentSchedule(p2, { signer, periods, maxTotalAmount: "20000", assets: scoped })).resolves.toHaveLength(2);
    const elsewhere = { ...p2, network: "eip155:1" as const };
    await expect(signPaymentSchedule(elsewhere, { signer, periods, maxTotalAmount: "20000", assets: scoped })).rejects.toThrow(/allowlist/);
  });
});

describe("chain-scoped asset allowlist (wrapFetch)", () => {
  it("does not sign a 402 that names the allowlisted address on a different chain", async () => {
    const elsewhere = { ...terms, network: "eip155:1" as const };
    const fetchImpl = vi.fn(async () => r402(undefined, [elsewhere]));
    const onSkipped = vi.fn();
    const paid = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      assets: [`${terms.network}/erc20:${terms.asset}`],
      maxAmount: "10000",
      onSkipped,
    });
    expect((await paid("http://api.local/premium")).status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("axios cross-origin guard (browser shape)", () => {
  it("refuses to treat a retry that landed on another origin as paid, using request.responseURL", async () => {
    let onRejected!: (e: unknown) => Promise<unknown>;
    const axios = {
      interceptors: { response: { use: (_ok: unknown, bad: typeof onRejected) => ((onRejected = bad), 0) } },
      request: vi.fn(async (config: Record<string, unknown>) => ({
        status: 200,
        headers: {},
        config,
        request: { responseURL: "http://evil.example/landed" }, // XHR adapter field
      })),
    };
    const onSkipped = vi.fn();
    attachX402(axios as never, { signer, allowAnyAsset: true, maxAmount: "10000", onSkipped });
    const header = r402().headers.get(HEADER_PAYMENT_REQUIRED)!;
    const error = {
      response: { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: header }, config: { url: "http://api.local/premium" } },
    };
    await onRejected(error);
    expect(onSkipped).toHaveBeenCalledWith(expect.stringMatching(/crossed origins/), expect.anything());
    const sent = axios.request.mock.calls[0]![0] as Record<string, unknown>;
    expect((sent.fetchOptions as { redirect: string }).redirect).toBe("manual");
  });
});
