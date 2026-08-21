/**
 * Axios adapter — pays a 402 (which axios surfaces as a rejection), retries
 * once with a valid signature, and enforces the same maxAmount cap as wrapFetch.
 */

import { describe, expect, it, vi } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  buildPaymentRequired,
  buildTransferTypedData,
  decodePaymentPayload,
  encodePaymentRequired,
  type ExactPayload,
  type PaymentRequirements,
} from "@x402.kit/core";
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

/** A tiny axios stand-in that runs interceptors and lets us script responses */
function mockAxios(scripted: { onRequest(config: Record<string, unknown>): { status: number; headers: Record<string, string>; data?: unknown } }) {
  let onRejected: ((e: unknown) => Promise<unknown>) | undefined;
  const request = vi.fn(async (config: Record<string, unknown>) => {
    const res = scripted.onRequest(config);
    const full = { ...res, config };
    // axios default validateStatus resolves status < 400 (3xx included when
    // maxRedirects: 0), rejects >= 400.
    if (res.status < 400) return full;
    const err = { response: full, config };
    if (onRejected) return onRejected(err);
    throw err;
  });
  return {
    request,
    interceptors: { response: { use: (_ok: unknown, rej: (e: unknown) => Promise<unknown>) => void (onRejected = rej) } },
  };
}

function required402(): Record<string, string> {
  const body = buildPaymentRequired({ resource: { url: "http://api.local/x" }, accepts: [terms] });
  return { [HEADER_PAYMENT_REQUIRED.toLowerCase()]: encodePaymentRequired(body) };
}

describe("attachX402", () => {
  it("pays a 402 rejection and retries once with a valid signature", async () => {
    let calls = 0;
    const axios = mockAxios({
      onRequest: () => {
        calls++;
        return calls === 1 ? { status: 402, headers: required402() } : { status: 200, headers: {}, data: "premium" };
      },
    });
    attachX402(axios as never, { signer, allowAnyAsset: true, maxAmount: "1000000" });

    const res = await axios.request({ url: "http://api.local/x" });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    const retryConfig = axios.request.mock.calls[1]![0] as { headers: Record<string, string> };
    const payloadHeader = retryConfig.headers[HEADER_PAYMENT_SIGNATURE];
    const payload = decodePaymentPayload<ExactPayload>(payloadHeader);
    const recovered = await recoverTypedDataAddress({
      ...buildTransferTypedData(
        { name: "USDC", version: "2", chainId: 84532, verifyingContract: terms.asset },
        payload.payload.authorization,
      ),
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("never signs above maxAmount — the 402 rejection propagates", async () => {
    let calls = 0;
    const axios = mockAxios({ onRequest: () => (calls++, { status: 402, headers: required402() }) });
    const onSkipped = vi.fn();
    attachX402(axios as never, { signer, allowAnyAsset: true, maxAmount: "9999", onSkipped });

    await expect(axios.request({ url: "http://api.local/x" })).rejects.toBeDefined();
    expect(calls).toBe(1); // no retry
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("exceeds maxAmount"), [terms]);
  });

  it("requires maxAmount", () => {
    const axios = mockAxios({ onRequest: () => ({ status: 200, headers: {} }) });
    expect(() => attachX402(axios as never, { signer, maxAmount: "" })).toThrow(/maxAmount/);
  });

  it("refuses to forward the signature when the paid retry redirects", async () => {
    let calls = 0;
    const axios = mockAxios({
      onRequest: () => {
        calls++;
        // first: 402; retry: a 302 redirect (which we must not follow with the signature)
        return calls === 1 ? { status: 402, headers: required402() } : { status: 302, headers: { location: "https://attacker.example/" } };
      },
    });
    const onSkipped = vi.fn();
    attachX402(axios as never, { signer, allowAnyAsset: true, maxAmount: "1000000", onSkipped });

    const res = await axios.request({ url: "http://api.local/x" });
    expect(res.status).toBe(302); // returned as-is, signature not chased to the target
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("redirect"), expect.anything());

    // the retry request pinned maxRedirects: 0
    const retryConfig = axios.request.mock.calls[1]![0] as { maxRedirects?: number };
    expect(retryConfig.maxRedirects).toBe(0);
  });
});
