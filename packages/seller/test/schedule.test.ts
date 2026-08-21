import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type {
  FacilitatorRequest,
  PaymentRequirements,
  SettleResponse,
} from "@x402.kit/core";
import { signPaymentSchedule } from "@x402.kit/buyer";
import {
  chargeScheduled,
  dueEntries,
  scheduleWindow,
  validateSchedule,
} from "../src/schedule.js";

const signer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const NOW = 1_800_000_000;
const MONTH = 2_592_000;

const terms: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "permit2" },
};

async function signedSchedule(count = 3) {
  return signPaymentSchedule(terms, {
    assets: [terms.asset],
    signer,
    periods: { start: NOW, periodSeconds: MONTH, count },
    maxTotalAmount: "100000",
  });
}

/** A validated schedule, or throw — the accepted-path fixture */
async function acceptedEntries(count = 3) {
  const result = validateSchedule(await signedSchedule(count), [terms]);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("validateSchedule", () => {
  it("accepts a well-formed schedule and derives ascending windows", async () => {
    const entries = await acceptedEntries();
    expect(entries).toHaveLength(3);
    const starts = entries.map((e) => scheduleWindow(e.payload).notBefore);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("rejects entries signing terms the seller never offered", async () => {
    const result = validateSchedule(await signedSchedule(1), [
      { ...terms, amount: "999" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/match none/);
  });

  it("rejects a duplicated payload — every installment must be its own payment", async () => {
    const [one] = await signedSchedule(1);
    const result = validateSchedule([one, one], [terms]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate payment identity/);
  });

  it("rejects non-arrays, empty arrays, and malformed members", () => {
    expect(validateSchedule({}, [terms]).ok).toBe(false);
    expect(validateSchedule([], [terms]).ok).toBe(false);
    expect(validateSchedule([{ hello: 1 }], [terms]).ok).toBe(false);
  });
});

describe("dueEntries / chargeScheduled", () => {
  it("filters to the entries whose window contains now", async () => {
    const entries = await acceptedEntries();
    expect(dueEntries(entries, NOW - 3600)).toHaveLength(0); // before period 1
    expect(dueEntries(entries, NOW + 60)).toHaveLength(1); // inside period 1
    expect(dueEntries(entries, NOW + MONTH + 60)).toHaveLength(1); // inside period 2
    expect(dueEntries(entries, NOW + 3 * MONTH + 3600)).toHaveLength(0); // all expired
  });

  it("chargeScheduled submits the standard settle request", async () => {
    const entry = (await acceptedEntries(1))[0]!;
    const settle = vi.fn(
      async (req: FacilitatorRequest): Promise<SettleResponse> => ({
        success: true,
        transaction: "0xabc",
        network: req.paymentRequirements.network,
      }),
    );
    const response = await chargeScheduled(entry, { verify: vi.fn(), settle });
    expect(response.success).toBe(true);
    expect(settle).toHaveBeenCalledWith({
      x402Version: 2,
      paymentPayload: entry.payload,
      paymentRequirements: entry.requirements,
    });
  });
});
