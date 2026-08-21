import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  isPermit2Payload,
  type ExactPermit2Payload,
  type PaymentRequirements,
} from "@x402kit/core";
import { signPaymentSchedule } from "../src/schedule.js";

const signer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const NOW = 1_800_000_000;
const MONTH = 2_592_000;

const permit2Terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "permit2" },
};

describe("signPaymentSchedule", () => {
  it("signs one independent payment per period with window-confined validity", async () => {
    const payloads = await signPaymentSchedule(permit2Terms, {
      assets: [permit2Terms.asset],
      signer,
      periods: { start: NOW, periodSeconds: MONTH, count: 3 },
      maxTotalAmount: "30000",
    });
    expect(payloads).toHaveLength(3);
    const nonces = new Set<string>();
    payloads.forEach((p, i) => {
      expect(isPermit2Payload(p.payload)).toBe(true);
      const auth = (p.payload as ExactPermit2Payload).permit2Authorization;
      nonces.add(auth.nonce);
      // each window is pinned to exactly [start, end) — no cross-period overlap
      expect(Number(auth.witness.validAfter)).toBe(NOW + i * MONTH);
      expect(Number(auth.deadline)).toBe(NOW + (i + 1) * MONTH - 1);
      expect(auth.permitted.amount).toBe("10000");
    });
    expect(nonces.size).toBe(3); // every installment is its own on-chain payment
  });

  it("works for eip3009 terms too — the pattern is transfer-method-agnostic", async () => {
    const eip3009: PaymentRequirements = {
      ...permit2Terms,
      extra: { name: "USDC", version: "2" },
    };
    const [payload] = await signPaymentSchedule(eip3009, {
      assets: [eip3009.asset],
      signer,
      periods: [{ start: NOW, end: NOW + MONTH }],
      maxTotalAmount: "10000",
    });
    expect(isPermit2Payload(payload!.payload)).toBe(false);
  });

  it("refuses a schedule whose total exceeds maxTotalAmount", async () => {
    await expect(
      signPaymentSchedule(permit2Terms, {
        assets: [permit2Terms.asset],
        signer,
        periods: { start: NOW, periodSeconds: MONTH, count: 4 },
        maxTotalAmount: "30000", // 4 × 10000 > 30000
      }),
    ).rejects.toThrow(/exceeds maxTotalAmount/);
  });

  it("refuses malformed and overlapping windows", async () => {
    await expect(
      signPaymentSchedule(permit2Terms, {
        assets: [permit2Terms.asset],
        signer,
        periods: [
          { start: NOW, end: NOW + MONTH },
          { start: NOW + MONTH - 1, end: NOW + 2 * MONTH }, // overlaps
        ],
        maxTotalAmount: "30000",
      }),
    ).rejects.toThrow(/overlaps/);
    await expect(
      signPaymentSchedule(permit2Terms, {
        assets: [permit2Terms.asset],
        signer,
        periods: [{ start: NOW, end: NOW }],
        maxTotalAmount: "30000",
      }),
    ).rejects.toThrow(/malformed/);
  });

  it("refuses non-exact schemes and empty schedules", async () => {
    await expect(
      signPaymentSchedule(
        { ...permit2Terms, scheme: "upto" },
        {
          assets: [permit2Terms.asset],
          signer,
          periods: [{ start: NOW, end: NOW + MONTH }],
          maxTotalAmount: "10000",
        },
      ),
    ).rejects.toThrow(/exact/);
    await expect(
      signPaymentSchedule(permit2Terms, {
        assets: [permit2Terms.asset],
        signer,
        periods: [],
        maxTotalAmount: "10000",
      }),
    ).rejects.toThrow(/at least one/);
  });
});
