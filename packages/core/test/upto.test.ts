/**
 * upto — sign a cap, settle the actual. Mirrors permit2.test.ts: canned chain
 * reads, REAL signature recovery, and a golden digest derived by hand from
 * the contract's witnessTypeString.
 */

import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ErrorReason,
  ErrorReasonExtra,
  PERMIT2_ADDRESS,
  UPTO_PERMIT2_WITNESS_TYPE_STRING,
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  buildUptoDigest,
  isUptoPayload,
  uptoScheme,
  type ChainContext,
  type PaymentPayload,
  type PaymentRequirements,
  type UptoPayload,
  type UptoPermit2Authorization,
} from "../src/index.js";
import { CHAIN_ID, testAccount } from "./fixtures.js";

const FACILITATOR = "0x1111111111111111111111111111111111111111" as const;
const OTHER_FACILITATOR = "0x2222222222222222222222222222222222222222" as const;

/** upto terms — what seller-side uptoTerms() produces */
const cap: PaymentRequirements = {
  scheme: "upto",
  network: "eip155:84532",
  amount: "10000", // the CAP
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR },
};

const NOW = 1_800_000_000;

async function build(req: PaymentRequirements = cap): Promise<PaymentPayload<UptoPayload>> {
  return uptoScheme.buildPayload(req, { signer: testAccount, now: NOW });
}

interface StubState {
  blockTimestamp?: bigint;
  nonceBitmap?: bigint;
  balance?: bigint;
  allowance?: bigint;
  simulateError?: boolean;
  proxyCodeless?: boolean;
}

function stubCtx(state: StubState = {}): ChainContext & { simulate: ReturnType<typeof vi.fn> } {
  const simulate = vi.fn(async () => {
    if (state.simulateError) throw new Error("execution reverted");
    return { request: { stub: true } };
  });
  const publicClient = {
    getBlock: async () => ({ timestamp: state.blockTimestamp ?? BigInt(NOW), number: 100n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "nonceBitmap") return state.nonceBitmap ?? 0n;
      if (functionName === "balanceOf") return state.balance ?? 1_000_000n;
      if (functionName === "allowance") return state.allowance ?? 1_000_000n;
      throw new Error(`unexpected read: ${functionName}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verifyTypedData: async (args: any) => {
      const recovered = await recoverTypedDataAddress({
        domain: args.domain,
        types: args.types,
        primaryType: args.primaryType,
        message: args.message,
        signature: args.signature,
      });
      return recovered.toLowerCase() === args.address.toLowerCase();
    },
    simulateContract: simulate,
    getCode: async () => (state.proxyCodeless ? "0x" : "0x60006000"),
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 101n }),
  } as unknown as PublicClient;
  // settlerAddress: the address settle will run from — what witness.facilitator must equal
  return { network: "eip155:84532", chainId: CHAIN_ID, publicClient, settlerAddress: FACILITATOR, simulate };
}

function withWallet<T extends ChainContext>(ctx: T): T & { writes: ReturnType<typeof vi.fn> } {
  const writes = vi.fn(async () => "0xdeadbeef" as Hex);
  const walletClient = { account: { address: FACILITATOR }, writeContract: writes } as unknown as WalletClient;
  return { ...ctx, walletClient, writes };
}

describe("upto's EIP-712 — byte-identical to the proxy's witnessTypeString", () => {
  const auth: UptoPermit2Authorization = {
    permitted: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000" },
    from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    spender: X402_UPTO_PERMIT2_PROXY_ADDRESS,
    nonce: "33247007178036348590600198031289925668252061821958005840077069883511451257277",
    deadline: "1740672154",
    witness: { to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", facilitator: FACILITATOR, validAfter: "1740672089" },
  };

  it("viem's type encoding equals Permit2's stub + the upto witnessTypeString", () => {
    const STUB =
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    const typeHash = keccak256(toBytes(STUB + UPTO_PERMIT2_WITNESS_TYPE_STRING));
    const permittedHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [keccak256(toBytes("TokenPermissions(address token,uint256 amount)")), auth.permitted.token, BigInt(auth.permitted.amount)],
      ),
    );
    // The on-chain WITNESS_TYPEHASH (x402UptoPermit2Proxy.sol) — the vendored
    // bytecode was checked to contain this exact hash
    const witnessTypeHash = keccak256(toBytes("Witness(address to,address facilitator,uint256 validAfter)"));
    expect(witnessTypeHash).toBe("0xd4171c445a74218b01d4fd8af34ff1106580ea1e36ff837e64484bfaa2253b75");
    const witnessHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [witnessTypeHash, auth.witness.to, auth.witness.facilitator, BigInt(auth.witness.validAfter)],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [typeHash, permittedHash, auth.spender, BigInt(auth.nonce), BigInt(auth.deadline), witnessHash],
      ),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toBytes("EIP712Domain(string name,uint256 chainId,address verifyingContract)")),
          keccak256(toBytes("Permit2")),
          BigInt(CHAIN_ID),
          PERMIT2_ADDRESS,
        ],
      ),
    );
    const expected = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`);
    expect(buildUptoDigest({ chainId: CHAIN_ID }, auth)).toBe(expected);
  });
});

describe("upto buildPayload", () => {
  it("signs the cap, names the upto proxy, and binds the terms' facilitator into the witness", async () => {
    const payload = await build();
    expect(isUptoPayload(payload.payload)).toBe(true);
    const auth = payload.payload.permit2Authorization;
    expect(auth.permitted.amount).toBe("10000");
    expect(auth.spender).toBe(X402_UPTO_PERMIT2_PROXY_ADDRESS);
    expect(auth.witness.facilitator).toBe(FACILITATOR);
    expect(auth.witness.to).toBe(cap.payTo);
    expect(auth.deadline).toBe(String(NOW + 60));
    expect(payload.accepted).toEqual(cap);
  });

  it("refuses terms without a facilitator address — the buyer cannot bind what it does not know", async () => {
    await expect(build({ ...cap, extra: { assetTransferMethod: "permit2" } })).rejects.toThrow(/facilitatorAddress/);
    expect(uptoScheme.validateRequirements?.({ ...cap, extra: { assetTransferMethod: "eip3009" } })).toMatch(/Permit2 only/);
  });

  it("paymentId is the signed (from, nonce), and never throws on garbage", async () => {
    const payload = await build();
    const id = uptoScheme.paymentId(payload, cap);
    expect(id).toBe(`${testAccount.address.toLowerCase()}:${payload.payload.permit2Authorization.nonce}`);
    expect(() => uptoScheme.paymentId({ payload: { permit2Authorization: { nonce: "0xzz" } } } as never, cap)).not.toThrow();
  });
});

describe("upto verify — against the cap", () => {
  it("passes when the payer can cover the FULL cap", async () => {
    const ctx = stubCtx();
    const result = await uptoScheme.verify(await build(), cap, ctx);
    expect(result).toEqual({ isValid: true, payer: testAccount.address });
    // simulation ran with the cap — the worst case
    expect((ctx.simulate.mock.calls[0] as unknown[])[0]).toMatchObject({ args: expect.arrayContaining([10000n]) });
  });

  it("rejects a witness bound to some other facilitator", async () => {
    const result = await uptoScheme.verify(await build(), cap, stubCtx() && { ...stubCtx(), settlerAddress: OTHER_FACILITATOR });
    expect(result.invalidReason).toBe(ErrorReasonExtra.UPTO_FACILITATOR_MISMATCH);
  });

  it("rejects a signed cap that differs from the terms' amount", async () => {
    const payload = await build();
    const result = await uptoScheme.verify(payload, { ...cap, amount: "9999" }, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.INVALID_PAYMENT_REQUIREMENTS); // envelope echo catches it first
    const tampered = { ...payload, accepted: { ...cap, amount: "9999" } };
    const result2 = await uptoScheme.verify(tampered, { ...cap, amount: "9999" }, stubCtx());
    expect(result2.invalidReason).toBe(ErrorReasonExtra.PERMIT2_AMOUNT_MISMATCH);
  });

  it("rejects a spender other than the upto proxy (the exact proxy would move the full amount)", async () => {
    const payload = await build();
    payload.payload.permit2Authorization.spender = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
    const result = await uptoScheme.verify(payload, cap, stubCtx());
    expect(result.invalidReason).toBe(ErrorReasonExtra.PERMIT2_SPENDER);
  });

  it("needs allowance and balance for the cap, not some smaller expected charge", async () => {
    expect((await uptoScheme.verify(await build(), cap, stubCtx({ allowance: 9_999n }))).invalidReason).toBe(
      ErrorReasonExtra.PERMIT2_ALLOWANCE_REQUIRED,
    );
    expect((await uptoScheme.verify(await build(), cap, stubCtx({ balance: 9_999n }))).invalidReason).toBe(
      ErrorReason.INSUFFICIENT_FUNDS,
    );
  });

  it("judges time by chain time and the nonce by Permit2's bitmap", async () => {
    const payload = await build();
    const nonce = BigInt(payload.payload.permit2Authorization.nonce);
    // inside the settle-window margin (deadline NOW+60, margin 6) verify already refuses
    expect((await uptoScheme.verify(payload, cap, stubCtx({ blockTimestamp: BigInt(NOW + 55) }))).invalidReason).toBe(
      ErrorReasonExtra.PERMIT2_DEADLINE_EXPIRED,
    );
    expect((await uptoScheme.verify(payload, cap, stubCtx({ blockTimestamp: BigInt(NOW + 61) }))).invalidReason).toBe(
      ErrorReasonExtra.PERMIT2_DEADLINE_EXPIRED,
    );
    expect((await uptoScheme.verify(payload, cap, stubCtx({ blockTimestamp: BigInt(NOW - 120) }))).invalidReason).toBe(
      ErrorReasonExtra.PERMIT2_NOT_YET_VALID,
    );
    expect((await uptoScheme.verify(payload, cap, stubCtx({ nonceBitmap: 1n << (nonce & 0xffn) }))).invalidReason).toBe(
      ErrorReasonExtra.AUTHORIZATION_ALREADY_USED,
    );
  });

  it("rejects a tampered signature and a codeless proxy", async () => {
    const payload = await build();
    const forged = { ...payload, payload: { ...payload.payload, signature: `0x${"ab".repeat(65)}` as Hex } };
    expect((await uptoScheme.verify(forged, cap, stubCtx())).invalidReason).toBe(ErrorReasonExtra.PERMIT2_SIGNATURE);
    expect((await uptoScheme.verify(payload, cap, stubCtx({ proxyCodeless: true }))).invalidReason).toBe(
      ErrorReason.INVALID_TRANSACTION_STATE,
    );
  });
});

describe("upto settle — the ACTUAL amount rides in requirements.amount", () => {
  it("settles a partial amount: simulates and broadcasts with it, reports it", async () => {
    const ctx = withWallet(stubCtx());
    const result = await uptoScheme.settle(await build(), { ...cap, amount: "4000" }, ctx);
    expect(result).toMatchObject({ success: true, transaction: "0xdeadbeef", amount: "4000", payer: testAccount.address });
    expect((ctx.simulate.mock.calls[0] as unknown[])[0]).toMatchObject({ args: expect.arrayContaining([4000n]) });
    expect(ctx.writes).toHaveBeenCalledTimes(1);
  });

  it("settles the full cap when the seller asks for it", async () => {
    const ctx = withWallet(stubCtx());
    const result = await uptoScheme.settle(await build(), cap, ctx);
    expect(result).toMatchObject({ success: true, amount: "10000" });
  });

  it("$0 is a success with no transaction and no broadcast", async () => {
    const ctx = withWallet(stubCtx());
    const result = await uptoScheme.settle(await build(), { ...cap, amount: "0" }, ctx);
    expect(result).toEqual({ success: true, transaction: "", network: cap.network, payer: testAccount.address, amount: "0" });
    expect(ctx.writes).not.toHaveBeenCalled();
    expect(ctx.simulate).not.toHaveBeenCalled();
  });

  it("refuses to draw more than the signed cap — before any simulation", async () => {
    const ctx = withWallet(stubCtx());
    const result = await uptoScheme.settle(await build(), { ...cap, amount: "10001" }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.UPTO_SETTLEMENT_EXCEEDS_AMOUNT);
    expect(ctx.writes).not.toHaveBeenCalled();
  });

  it("re-verifies against the cap, so a consumed nonce fails settle even for a tiny amount", async () => {
    const payload = await build();
    const nonce = BigInt(payload.payload.permit2Authorization.nonce);
    const ctx = withWallet(stubCtx({ nonceBitmap: 1n << (nonce & 0xffn) }));
    const result = await uptoScheme.settle(payload, { ...cap, amount: "1" }, ctx);
    expect(result.errorReason).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  });

  it("a facilitator whose wallet is not the bound one cannot settle", async () => {
    const ctx = withWallet(stubCtx());
    (ctx.walletClient as { account: { address: string } }).account.address = OTHER_FACILITATOR;
    const result = await uptoScheme.settle(await build(), { ...cap, amount: "4000" }, ctx);
    expect(result.errorReason).toBe(ErrorReasonExtra.UPTO_FACILITATOR_MISMATCH);
  });
});
