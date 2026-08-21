import { describe, expect, it, vi } from "vitest";
import type { FacilitatorRequest, SupportedResponse } from "@x402kit/core";
import { createPaywall, erc3009Terms, permit2Terms } from "../src/index.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

/** Minimal PublicClient stand-in that answers eip712Domain() */
function mockClient(name: string, version: string) {
  return {
    readContract: vi.fn(async () => ["0x0f", name, version, 84532n, ASSET, `0x${"00".repeat(32)}`, []]),
  } as never;
}

describe("erc3009Terms", () => {
  it("auto-fills name/version from the token's eip712Domain()", async () => {
    const terms = await erc3009Terms({
      network: "eip155:84532",
      asset: ASSET,
      payTo: PAY_TO,
      amount: "10000",
      publicClient: mockClient("USD Coin", "2"),
    });
    expect(terms.extra?.name).toBe("USD Coin");
    expect(terms.extra?.version).toBe("2");
    expect(terms.amount).toBe("10000");
    expect(terms.scheme).toBe("exact");
  });

  it("keeps explicit extra and merges custom fields", async () => {
    const terms = await erc3009Terms({
      network: "eip155:84532",
      asset: ASSET,
      payTo: PAY_TO,
      amount: "100000000",
      extra: { name: "My Token", version: "1", tier: "premium" },
    });
    expect(terms.extra?.name).toBe("My Token"); // not overwritten
    expect(terms.extra?.tier).toBe("premium");
  });

  it("throws when neither publicClient nor extra.name is given", async () => {
    await expect(
      erc3009Terms({ network: "eip155:84532", asset: ASSET, payTo: PAY_TO, amount: "1" }),
    ).rejects.toThrow(/EIP-712 domain/);
  });
});

describe("permit2Terms", () => {
  it("builds exact terms with assetTransferMethod permit2 and no domain requirement", () => {
    const terms = permit2Terms({ network: "eip155:84532", asset: ASSET, payTo: PAY_TO, amount: "10000" });
    expect(terms.scheme).toBe("exact");
    expect(terms.extra?.assetTransferMethod).toBe("permit2");
    expect(terms.maxTimeoutSeconds).toBe(60);
    expect(terms.extra?.name).toBeUndefined();
  });

  it("forces assetTransferMethod even against a conflicting extra override", () => {
    const terms = permit2Terms({
      network: "eip155:84532",
      asset: ASSET,
      payTo: PAY_TO,
      amount: "10000",
      extra: { assetTransferMethod: "eip3009", note: "kept" },
    });
    expect(terms.extra?.assetTransferMethod).toBe("permit2");
    expect(terms.extra?.note).toBe("kept");
  });
});

describe("paywall.verifySupported", () => {
  const terms = {
    scheme: "exact" as const,
    network: "eip155:84532" as const,
    amount: "10000",
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };

  function supported(kinds: Array<{ scheme: string; network: string }>): SupportedResponse {
    return { kinds: kinds.map((k) => ({ x402Version: 2, ...k })), extensions: [], signers: {} };
  }

  it("no-op for an embedded facilitator (not a URL)", async () => {
    const embedded = { verify: vi.fn(), settle: vi.fn(async (_r: FacilitatorRequest) => ({}) as never) };
    const pw = createPaywall({ accepts: [terms], facilitator: embedded });
    await expect(pw.verifySupported()).resolves.toBeUndefined();
  });

  it("throws when the facilitator does not advertise the terms", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(supported([{ scheme: "exact", network: "eip155:8453" }])), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const pw = createPaywall({ accepts: [terms], facilitator: "http://f.local" });
    await expect(pw.verifySupported()).rejects.toThrow(/does not advertise/);
    vi.unstubAllGlobals();
  });

  it("passes when the terms are advertised", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(supported([{ scheme: "exact", network: "eip155:84532" }])), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const pw = createPaywall({ accepts: [terms], facilitator: "http://f.local" });
    await expect(pw.verifySupported()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
