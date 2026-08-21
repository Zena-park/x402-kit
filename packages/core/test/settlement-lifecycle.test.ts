/**
 * Settlement lifecycle — the money-correctness edges of settle.
 *
 *   - a transport error AFTER broadcast is pending, never a definite failure
 *   - a receipt for a REPLACEMENT tx (same nonce) proves nothing about ours
 *   - a reverted tx whose signed transfer landed anyway (front-run) is success
 *   - verify simulates from the same account settle will use, under a gas cap
 *   - settle never throws on a malformed payload
 *   - paymentId is canonical across casing variants
 */

import { describe, expect, it, vi } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";
import {
  ErrorReason,
  PendingReceiptError,
  SettlementRevertedError,
  broadcastAndConfirm,
  exactScheme,
  settleGasLimit,
  validateChainContext,
  type ChainContext,
  type ExactPayload,
  type PaymentPayload,
} from "../src/index.js";
import { CHAIN_ID, specRequirements, testAccount } from "./fixtures.js";

const TX = `0x${"ab".repeat(32)}` as Hex;
const OTHER = `0x${"cd".repeat(32)}` as Hex;
const NOW = 1_800_000_000;

function wallet(): WalletClient {
  return { account: { address: testAccount.address }, writeContract: vi.fn(async () => TX) } as unknown as WalletClient;
}

describe("broadcastAndConfirm", () => {
  it("any error while waiting for the receipt is PENDING (hash known, tx in flight)", async () => {
    const pc = {
      waitForTransactionReceipt: async () => {
        throw new Error("fetch failed: ECONNRESET");
      },
    } as unknown as PublicClient;
    await expect(broadcastAndConfirm(pc, wallet(), {} as never)).rejects.toBeInstanceOf(PendingReceiptError);
  });

  it("a receipt for a replacement tx (same nonce) is PENDING, not our success", async () => {
    const pc = {
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: OTHER, blockNumber: 10n }),
    } as unknown as PublicClient;
    await expect(broadcastAndConfirm(pc, wallet(), {} as never)).rejects.toBeInstanceOf(PendingReceiptError);
  });

  it("a reverted receipt for OUR hash is a definite failure carrying the block", async () => {
    const pc = {
      waitForTransactionReceipt: async () => ({ status: "reverted", transactionHash: TX, blockNumber: 12n }),
    } as unknown as PublicClient;
    const err = await broadcastAndConfirm(pc, wallet(), {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementRevertedError);
    expect((err as SettlementRevertedError).blockNumber).toBe(12n);
  });

  it("a successful receipt for our hash returns the hash", async () => {
    const pc = {
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: TX, blockNumber: 12n }),
    } as unknown as PublicClient;
    await expect(broadcastAndConfirm(pc, wallet(), {} as never)).resolves.toBe(TX);
  });
});

interface Stub {
  reverted?: boolean;
  transferLogs?: Array<{ args: { value: bigint }; transactionHash: Hex }>;
  /** AuthorizationUsed logs for the queried nonce; defaults to "every transfer tx consumed it" */
  usedLogs?: Array<{ transactionHash: Hex }>;
}

function ctx(state: Stub = {}, withWallet = true): ChainContext & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const publicClient = {
    chain: { id: CHAIN_ID },
    getBlock: async () => ({ timestamp: BigInt(NOW), number: 100n }),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "authorizationState" ? false : 1_000_000n,
    verifyTypedData: async () => true,
    simulateContract: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { request: { stub: true } };
    },
    getCode: async () => "0x6000",
    waitForTransactionReceipt: async () => ({
      status: state.reverted ? "reverted" : "success",
      transactionHash: TX,
      blockNumber: 105n,
    }),
    getLogs: async ({ event }: { event: { name: string } }) =>
      event.name === "AuthorizationUsed" ? (state.usedLogs ?? state.transferLogs ?? []) : (state.transferLogs ?? []),
  } as unknown as PublicClient;
  return {
    network: "eip155:84532",
    chainId: CHAIN_ID,
    publicClient,
    ...(withWallet ? { walletClient: wallet() } : {}),
    calls,
  };
}

async function build(): Promise<PaymentPayload<ExactPayload>> {
  return (await exactScheme.buildPayload(specRequirements, { signer: testAccount, now: NOW })) as PaymentPayload<ExactPayload>;
}

describe("exact settle lifecycle", () => {
  it("verify simulates from the settling account with the gas ceiling (no verify/settle oracle)", async () => {
    const c = ctx();
    await exactScheme.verify(await build(), specRequirements, c);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.account).toBe(testAccount.address);
    expect(c.calls[0]!.gas).toBe(settleGasLimit(c));
    // verify-only context: falls back to the declared settler, not payTo
    const verifyOnly = { ...ctx({}, false), settlerAddress: "0x1111111111111111111111111111111111111111" as const };
    await exactScheme.verify(await build(), specRequirements, verifyOnly);
    expect(verifyOnly.calls[0]!.account).toBe("0x1111111111111111111111111111111111111111");
  });

  it("settle passes the same gas ceiling into the broadcast request", async () => {
    const c = { ...ctx(), maxSettleGas: 123_456 };
    await exactScheme.settle(await build(), specRequirements, c);
    const settleSim = c.calls.at(-1)!;
    expect(settleSim.gas).toBe(123_456n);
  });

  it("a reverted settle whose signed transfer landed anyway (front-run) reports THAT tx as success", async () => {
    const payload = await build();
    const c = ctx({ reverted: true, transferLogs: [{ args: { value: 10000n }, transactionHash: OTHER }] });
    const result = await exactScheme.settle(payload, specRequirements, c);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe(OTHER);
  });

  it("an external transfer that did NOT consume this nonce is not this payment (equal-amount sibling)", async () => {
    const c = ctx({ reverted: true, transferLogs: [{ args: { value: 10000n }, transactionHash: OTHER }], usedLogs: [] });
    const result = await exactScheme.settle(await build(), specRequirements, c);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.INVALID_TRANSACTION_STATE);
  });

  it("one external transfer is never credited to two payments", async () => {
    const c = ctx({ reverted: true, transferLogs: [{ args: { value: 10000n }, transactionHash: OTHER }] });
    const first = await exactScheme.settle(await build(), specRequirements, c);
    expect(first).toMatchObject({ success: true, transaction: OTHER });
    const second = await exactScheme.settle(await build(), specRequirements, c); // fresh nonce, same amount
    expect(second.success).toBe(false);
  });

  it("our own successful tx is claimed, so a later revert cannot re-credit it", async () => {
    const seen = new Set<Hex>();
    const settlementLedger = { has: (h: Hex) => seen.has(h), add: (h: Hex) => void seen.add(h) };
    expect((await exactScheme.settle(await build(), specRequirements, { ...ctx(), settlementLedger })).transaction).toBe(TX);
    const reverted = { ...ctx({ reverted: true, transferLogs: [{ args: { value: 10000n }, transactionHash: TX }] }), settlementLedger };
    expect((await exactScheme.settle(await build(), specRequirements, reverted)).success).toBe(false);
  });

  it("verify demands a settle window of remaining validity; settle's re-verify does not", async () => {
    const short = (await exactScheme.buildPayload(specRequirements, { signer: testAccount, now: NOW, validForSeconds: 3 })) as PaymentPayload<ExactPayload>;
    expect((await exactScheme.verify(short, specRequirements, ctx())).invalidReason).toBe(ErrorReason.EXACT_VALID_BEFORE);
    expect((await exactScheme.verify(short, specRequirements, { ...ctx(), minRemainingValiditySeconds: 0 })).isValid).toBe(true);
    expect((await exactScheme.settle(short, specRequirements, ctx())).success).toBe(true);
  });

  it("a reverted settle with no matching transfer stays a definite failure (a cancelled nonce is not a payment)", async () => {
    const c = ctx({ reverted: true, transferLogs: [{ args: { value: 1n }, transactionHash: OTHER }] });
    const result = await exactScheme.settle(await build(), specRequirements, c);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.INVALID_TRANSACTION_STATE);
  });

  it("settle on a malformed payload returns invalid_payload instead of throwing", async () => {
    const bad = { x402Version: 2, accepted: specRequirements, payload: {} } as unknown as PaymentPayload<ExactPayload>;
    const result = await exactScheme.settle(bad, specRequirements, ctx());
    expect(result).toMatchObject({ success: false, errorReason: ErrorReason.INVALID_PAYLOAD });
  });

  it("paymentId is identical across address checksum and nonce hex casing", async () => {
    const payload = await build();
    const { from, nonce } = payload.payload.authorization;
    const variant: PaymentPayload<ExactPayload> = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: { ...payload.payload.authorization, from: from.toLowerCase() as Hex, nonce: nonce.toUpperCase().replace("0X", "0x") as Hex },
      },
    };
    expect(exactScheme.paymentId(variant, specRequirements)).toBe(exactScheme.paymentId(payload, specRequirements));
  });
});

describe("validateChainContext", () => {
  it("rejects a network/chainId/client disagreement", () => {
    const base = ctx();
    expect(() => validateChainContext(base)).not.toThrow();
    expect(() => validateChainContext({ ...base, chainId: 1 })).toThrow(/mismatch/);
    expect(() => validateChainContext({ ...base, network: "eip155:1" })).toThrow(/mismatch/);
    expect(() => validateChainContext({ ...base, network: "solana:mainnet" })).toThrow(/eip155/);
  });
});
