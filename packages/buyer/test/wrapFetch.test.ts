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
} from "@x402kit/core";
import { signPayment, wrapFetch } from "../src/index.js";

const signer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

function paymentRequired402(accepts: PaymentRequirements[] = [terms]): Response {
  const body = buildPaymentRequired({ resource: { url: "http://api.local/premium" }, accepts });
  return new Response("{}", {
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body) },
  });
}

describe("wrapFetch", () => {
  it("pays a 402 and retries once with a valid signature", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(paymentRequired402())
      .mockResolvedValueOnce(new Response("premium", { status: 200 }));
    const onPaid = vi.fn();

    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "1000000",
      onPaid,
    });
    const res = await paidFetch("http://api.local/premium");

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onPaid).toHaveBeenCalledWith(terms, undefined); // no PAYMENT-RESPONSE header in the mock

    const retryReq = fetchImpl.mock.calls[1]![0] as Request;
    const header = retryReq.headers.get(HEADER_PAYMENT_SIGNATURE)!;
    const payload = decodePaymentPayload<ExactPayload>(header);
    expect(payload.accepted).toEqual(terms);
    expect(payload.payload.authorization.value).toBe(terms.amount);

    const recovered = await recoverTypedDataAddress({
      ...buildTransferTypedData(
        { name: "USDC", version: "2", chainId: 84532, verifyingContract: terms.asset },
        payload.payload.authorization,
      ),
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("never signs above maxAmount — returns the original 402", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(paymentRequired402());
    const onSkipped = vi.fn();

    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "9999", // below the demanded 10000
      onSkipped,
    });
    const res = await paidFetch("http://api.local/premium");

    expect(res.status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, nothing signed
    expect(onSkipped).toHaveBeenCalledWith(expect.stringContaining("exceeds maxAmount"), [terms]);
  });

  it("skips an over-cap entry and pays a cheaper one further down", async () => {
    const cheap: PaymentRequirements = { ...terms, amount: "500" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(paymentRequired402([terms, cheap])) // expensive first
      .mockResolvedValueOnce(new Response("premium", { status: 200 }));

    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "1000", // below terms(10000), above cheap(500)
    });
    const res = await paidFetch("http://api.local/premium");

    expect(res.status).toBe(200);
    const retryReq = fetchImpl.mock.calls[1]![0] as Request;
    const header = retryReq.headers.get(HEADER_PAYMENT_SIGNATURE)!;
    expect(decodePaymentPayload<ExactPayload>(header).payload.authorization.value).toBe("500");
  });

  it("skips terms whose scheme this buyer does not support", async () => {
    const unknownScheme: PaymentRequirements = { ...terms, scheme: "streaming-v9" };
    const fetchImpl = vi.fn().mockResolvedValueOnce(paymentRequired402([unknownScheme]));
    const onSkipped = vi.fn();
    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "10000",
      onSkipped,
    });
    const res = await paidFetch("http://api.local/metered");
    expect(res.status).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never signed
    expect(onSkipped).toHaveBeenCalledWith(expect.any(String), [unknownScheme]);
  });

  it("clamps a server's over-long validity window instead of trusting it", async () => {
    // server demands a 1-year window; the buyer signs only its default 300s ceiling
    const longLived: PaymentRequirements = { ...terms, maxTimeoutSeconds: 31_536_000 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(paymentRequired402([longLived]))
      .mockResolvedValueOnce(new Response("premium", { status: 200 }));
    const now = 1_800_000_000;
    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "100000",
      clock: () => now,
    });
    await paidFetch("http://api.local/premium");
    const retryReq = fetchImpl.mock.calls[1]![0] as Request;
    const payload = decodePaymentPayload<ExactPayload>(retryReq.headers.get(HEADER_PAYMENT_SIGNATURE)!);
    expect(Number(payload.payload.authorization.validBefore)).toBe(now + 300); // default ceiling, not a year
  });

  it("clamps the signed validity window to min(server, maxValiditySeconds)", async () => {
    // server asks 600s; ceiling is 120s → the shorter wins
    const wide: PaymentRequirements = { ...terms, maxTimeoutSeconds: 600 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(paymentRequired402([wide]))
      .mockResolvedValueOnce(new Response("premium", { status: 200 }));
    const now = 1_800_000_000;
    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      allowAnyAsset: true,
      maxAmount: "1000000",
      maxValiditySeconds: 120,
      clock: () => now,
    });
    await paidFetch("http://api.local/premium");
    const retryReq = fetchImpl.mock.calls[1]![0] as Request;
    const payload = decodePaymentPayload<ExactPayload>(retryReq.headers.get(HEADER_PAYMENT_SIGNATURE)!);
    expect(Number(payload.payload.authorization.validBefore)).toBe(now + 120);
  });

  it("passes non-402 responses through untouched", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, { signer, allowAnyAsset: true, maxAmount: "1" });
    const res = await paidFetch("http://api.local/free");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires maxAmount", () => {
    expect(() => wrapFetch(fetch, { signer, maxAmount: "" })).toThrow(/maxAmount/);
  });

  it("requires an asset allowlist unless allowAnyAsset is set (maxAmount is token-blind)", () => {
    expect(() => wrapFetch(fetch, { signer, maxAmount: "1000000" })).toThrow(/assets/);
    expect(() => wrapFetch(fetch, { signer, maxAmount: "1000000", assets: [] })).toThrow(/assets/);
    // an explicit allowlist, or the explicit opt-out, both construct fine
    expect(() => wrapFetch(fetch, { signer, maxAmount: "1000000", assets: [terms.asset] })).not.toThrow();
    expect(() => wrapFetch(fetch, { signer, maxAmount: "1000000", allowAnyAsset: true })).not.toThrow();
  });

  it("skips a 402 that names a token outside the asset allowlist (hostile-token defense)", async () => {
    const wbtc: PaymentRequirements = { ...terms, asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" };
    const fetchImpl = vi.fn().mockResolvedValueOnce(paymentRequired402([wbtc]));
    const onSkipped = vi.fn();
    const paidFetch = wrapFetch(fetchImpl as unknown as typeof fetch, {
      signer,
      maxAmount: "1000000",
      assets: [terms.asset], // only the intended token
      onSkipped,
    });
    const res = await paidFetch("http://api.local/premium");
    expect(res.status).toBe(402); // never signed the WBTC terms
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("signPayment", () => {
  it("signs the given terms directly (QR/POS flow)", async () => {
    const payload = await signPayment(terms, { signer });
    expect((payload.payload as ExactPayload).authorization.to).toBe(terms.payTo);
  });

  it("rejects unknown schemes", async () => {
    await expect(signPayment({ ...terms, scheme: "recurring" }, { signer })).rejects.toThrow(/scheme/);
  });
});
