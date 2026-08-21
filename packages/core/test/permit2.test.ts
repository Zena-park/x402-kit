import { describe, expect, it } from "vitest";
import {
  concatHex,
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
  PERMIT2_WITNESS_TYPE_STRING,
  X402_PERMIT2_PROXY_ADDRESS,
  buildPermit2Digest,
  buildPermit2TypedData,
  exactScheme,
  isPermit2Payload,
  type ChainContext,
  type ExactPayload,
  type ExactPermit2Payload,
  type PaymentPayload,
  type PaymentRequirements,
  type Permit2Authorization,
} from "../src/index.js";
import { CHAIN_ID, specRequirements, testAccount } from "./fixtures.js";

/** exact terms settled via permit2 — what seller-side permit2Terms() produces */
const permit2Requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "permit2" },
};

/** Fixed reference time so deadline/validAfter are deterministic in tests */
const NOW = 1_800_000_000;

async function buildPermit2(req: PaymentRequirements = permit2Requirements) {
  return (await exactScheme.buildPayload(req, {
    signer: testAccount,
    now: NOW,
  })) as PaymentPayload<ExactPermit2Payload>;
}

interface StubState {
  blockTimestamp?: bigint;
  nonceBitmap?: bigint;
  balance?: bigint;
  allowance?: bigint;
  simulateError?: boolean;
  receiptReverted?: boolean;
  proxyCodeless?: boolean;
}

/** ChainContext whose chain reads are canned — signature checks stay real (recover + compare) */
function stubCtx(state: StubState = {}): ChainContext {
  const publicClient = {
    getBlock: async () => ({ timestamp: state.blockTimestamp ?? BigInt(NOW) }),
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
    simulateContract: async () => {
      if (state.simulateError) throw new Error("execution reverted");
      return { request: { stub: true } };
    },
    getCode: async () => (state.proxyCodeless ? "0x" : "0x60006000"),
    waitForTransactionReceipt: async () => ({ status: state.receiptReverted ? "reverted" : "success" }),
  } as unknown as PublicClient;

  return { network: "eip155:84532", chainId: CHAIN_ID, publicClient };
}

function withWallet(ctx: ChainContext): ChainContext {
  const walletClient = {
    account: { address: "0x1111111111111111111111111111111111111111" },
    writeContract: async () => "0xdeadbeef" as Hex,
  } as unknown as WalletClient;
  return { ...ctx, walletClient };
}

describe("permit2's EIP-712 — byte-identical to Permit2's on-chain hashing", () => {
  const auth: Permit2Authorization = {
    permitted: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000" },
    from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    spender: X402_PERMIT2_PROXY_ADDRESS,
    nonce: "33247007178036348590600198031289925668252061821958005840077069883511451257277",
    deadline: "1740672154",
    witness: { to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", validAfter: "1740672089" },
  };

  it("viem's canonical type encoding equals Permit2's stub + witnessTypeString concatenation", () => {
    // Re-derive the digest by hand, exactly as SignatureTransfer.sol does:
    // typehash = keccak(stub ++ witnessTypeString), struct fields hashed per
    // EIP-712. If viem's alphabetical type ordering ever diverged from the
    // on-chain concatenation, this digest would differ and signatures would
    // never verify on-chain.
    const STUB =
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    const typeHash = keccak256(toBytes(STUB + PERMIT2_WITNESS_TYPE_STRING));
    const permittedHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [
          keccak256(toBytes("TokenPermissions(address token,uint256 amount)")),
          auth.permitted.token,
          BigInt(auth.permitted.amount),
        ],
      ),
    );
    const witnessHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [
          keccak256(toBytes("Witness(address to,uint256 validAfter)")),
          auth.witness.to,
          BigInt(auth.witness.validAfter),
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
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
    const digest = keccak256(concatHex(["0x1901", domainSeparator, structHash]));

    expect(buildPermit2Digest({ chainId: CHAIN_ID }, auth)).toBe(digest);
  });

  it("a buildPayload signature recovers to the signer address (EOA round trip)", async () => {
    const payload = await buildPermit2();
    const auth2 = payload.payload.permit2Authorization;

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(permit2Requirements);
    expect(auth2.from).toBe(testAccount.address);
    expect(auth2.spender).toBe(X402_PERMIT2_PROXY_ADDRESS);
    expect(auth2.permitted.token).toBe(permit2Requirements.asset);
    expect(auth2.permitted.amount).toBe(permit2Requirements.amount);
    expect(auth2.witness.to).toBe(permit2Requirements.payTo);
    expect(auth2.deadline).toBe(String(NOW + 60));

    const recovered = await recoverTypedDataAddress({
      ...buildPermit2TypedData({ chainId: CHAIN_ID }, auth2),
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(testAccount.address);
  });

  it("concurrent payments never block each other — nonces are random", async () => {
    const [a, b] = await Promise.all([buildPermit2(), buildPermit2()]);
    expect(a.payload.permit2Authorization.nonce).not.toBe(b.payload.permit2Authorization.nonce);
  });
});

describe("exact handler routes between eip3009 and permit2", () => {
  it("assetTransferMethod permit2 builds a permit2 payload; a plain domain builds eip3009", async () => {
    const p2 = await exactScheme.buildPayload(permit2Requirements, { signer: testAccount });
    expect(isPermit2Payload(p2.payload)).toBe(true);

    const p3009 = await exactScheme.buildPayload(specRequirements, { signer: testAccount });
    expect(isPermit2Payload(p3009.payload)).toBe(false);
    expect((p3009.payload as ExactPayload).authorization).toBeDefined();
  });

  it("unspecified method without a token domain falls back to permit2 (spec preference order)", async () => {
    const domainless: PaymentRequirements = { ...permit2Requirements, extra: {} };
    const payload = await exactScheme.buildPayload(domainless, { signer: testAccount });
    expect(isPermit2Payload(payload.payload)).toBe(true);
  });

  it("validateRequirements: permit2 terms need no token domain; unknown methods are rejected", () => {
    expect(exactScheme.validateRequirements?.(permit2Requirements)).toBeUndefined();
    expect(
      exactScheme.validateRequirements?.({
        ...permit2Requirements,
        extra: { assetTransferMethod: "erc7710" },
      }),
    ).toMatch(/not supported/);
    // domainless terms without an explicit method still fail seller-side validation
    expect(exactScheme.validateRequirements?.({ ...permit2Requirements, extra: {} })).toMatch(/domain/);
  });

  it("a permit2 payload against explicit eip3009 terms is rejected (and vice versa)", async () => {
    const payload = await buildPermit2();
    const eip3009Only: PaymentRequirements = {
      ...permit2Requirements,
      extra: { ...specRequirements.extra, assetTransferMethod: "eip3009" },
    };
    const result = await exactScheme.verify(payload, eip3009Only, stubCtx());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ErrorReason.INVALID_PAYLOAD);

    const p3009 = await exactScheme.buildPayload(specRequirements, { signer: testAccount, now: NOW });
    const asPermit2 = await exactScheme.verify(p3009, permit2Requirements, stubCtx());
    expect(asPermit2.isValid).toBe(false);
    expect(asPermit2.invalidReason).toBe(ErrorReason.INVALID_PAYLOAD);
  });

  it("paymentId keys on (from, nonce) for permit2 payloads", async () => {
    const payload = await buildPermit2();
    const auth = payload.payload.permit2Authorization;
    // canonical: lowercase address, decimal nonce — casing variants of one
    // payment must not become distinct idempotency keys
    expect(exactScheme.paymentId(payload, permit2Requirements)).toBe(`permit2:${auth.from.toLowerCase()}:${auth.nonce}`);
    // an eip3009 payload with the numerically equal nonce is a DIFFERENT payment (different nonce space)
    const eip3009 = { ...payload, payload: { signature: "0x", authorization: { from: auth.from, nonce: `0x${BigInt(auth.nonce).toString(16).padStart(64, "0")}` } } };
    expect(exactScheme.paymentId(eip3009 as never, permit2Requirements)).not.toBe(exactScheme.paymentId(payload, permit2Requirements));
  });
});

describe("permit2 verify — cheapest-first judgement", () => {
  it("accepts a valid payment", async () => {
    const result = await exactScheme.verify(await buildPermit2(), permit2Requirements, stubCtx());
    expect(result).toEqual({ isValid: true, payer: testAccount.address });
  });

  it("rejects a signed amount differing from the terms", async () => {
    const payload = await buildPermit2();
    payload.payload.permit2Authorization.permitted.amount = "999";
    const result = await exactScheme.verify(payload, permit2Requirements, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.EXACT_VALUE_MISMATCH);
  });

  it("rejects a recipient differing from payTo", async () => {
    const payload = await buildPermit2();
    payload.payload.permit2Authorization.witness.to = "0x1111111111111111111111111111111111111111";
    const result = await exactScheme.verify(payload, permit2Requirements, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.EXACT_RECIPIENT_MISMATCH);
  });

  it("rejects a spender other than the x402ExactPermit2Proxy", async () => {
    const payload = await buildPermit2();
    payload.payload.permit2Authorization.spender = "0x1111111111111111111111111111111111111111";
    const result = await exactScheme.verify(payload, permit2Requirements, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.INVALID_PAYLOAD);
  });

  it("rejects a permit over a different token than the terms' asset", async () => {
    const payload = await buildPermit2();
    payload.payload.permit2Authorization.permitted.token = "0x1111111111111111111111111111111111111111";
    const result = await exactScheme.verify(payload, permit2Requirements, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.INVALID_PAYLOAD);
  });

  it("judges deadline and validAfter by chain time", async () => {
    const payload = await buildPermit2();
    const expired = await exactScheme.verify(
      payload,
      permit2Requirements,
      stubCtx({ blockTimestamp: BigInt(NOW + 120) }),
    );
    expect(expired.invalidReason).toBe(ErrorReason.EXACT_VALID_BEFORE);

    const early = await exactScheme.verify(
      payload,
      permit2Requirements,
      stubCtx({ blockTimestamp: BigInt(NOW - 120) }),
    );
    expect(early.invalidReason).toBe(ErrorReason.EXACT_VALID_AFTER);
  });

  it("rejects a consumed unordered nonce (replay)", async () => {
    const payload = await buildPermit2();
    const bit = BigInt(payload.payload.permit2Authorization.nonce) & 0xffn;
    const result = await exactScheme.verify(
      payload,
      permit2Requirements,
      stubCtx({ nonceBitmap: 1n << bit }),
    );
    expect(result.invalidReason).toBe(ErrorReasonExtra.AUTHORIZATION_ALREADY_USED);
  });

  it("returns invalid_payload (never throws) for a malformed authorization", async () => {
    const cases = [
      { x402Version: 2, accepted: permit2Requirements, payload: { signature: "0x", permit2Authorization: {} } },
      { x402Version: 2, accepted: permit2Requirements, payload: { permit2Authorization: { from: "not-an-address" } } },
      { x402Version: 2, accepted: permit2Requirements, payload: {} },
    ];
    for (const bad of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await exactScheme.verify(bad as any, permit2Requirements, stubCtx());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(ErrorReason.INVALID_PAYLOAD);
    }
    // paymentId must not throw on any of them either (facilitator derives its
    // key from it before verify runs)
    for (const bad of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => exactScheme.paymentId(bad as any, permit2Requirements)).not.toThrow();
    }
  });

  it("rejects a tampered payload (signature no longer recovers)", async () => {
    const payload = await buildPermit2();
    payload.payload.permit2Authorization.nonce = "42";
    const result = await exactScheme.verify(payload, permit2Requirements, stubCtx());
    expect(result.invalidReason).toBe(ErrorReason.EXACT_SIGNATURE);
  });

  it("reports a missing Permit2 approval as the buyer's fix, not insufficient funds", async () => {
    const result = await exactScheme.verify(
      await buildPermit2(),
      permit2Requirements,
      stubCtx({ allowance: 0n }),
    );
    expect(result.invalidReason).toBe(ErrorReasonExtra.PERMIT2_ALLOWANCE_REQUIRED);
  });

  it("rejects an insufficient balance", async () => {
    const result = await exactScheme.verify(
      await buildPermit2(),
      permit2Requirements,
      stubCtx({ balance: 1n }),
    );
    expect(result.invalidReason).toBe(ErrorReason.INSUFFICIENT_FUNDS);
  });

  it("a simulation revert (blacklist/pause) fails verify — no pass-but-never-settles oracle", async () => {
    const result = await exactScheme.verify(
      await buildPermit2(),
      permit2Requirements,
      stubCtx({ simulateError: true }),
    );
    expect(result.invalidReason).toBe(ErrorReason.INVALID_TRANSACTION_STATE);
  });

  it("a codeless proxy (undeployed chain / typo'd override) fails verify — no no-op success", async () => {
    const result = await exactScheme.verify(
      await buildPermit2(),
      permit2Requirements,
      stubCtx({ proxyCodeless: true }),
    );
    expect(result.invalidReason).toBe(ErrorReason.INVALID_TRANSACTION_STATE);
  });
});

describe("permit2 settle", () => {
  it("re-verifies, simulates the proxy call, and reports the settled amount", async () => {
    const result = await exactScheme.settle(await buildPermit2(), permit2Requirements, withWallet(stubCtx()));
    expect(result).toEqual({
      success: true,
      transaction: "0xdeadbeef",
      network: "eip155:84532",
      payer: testAccount.address,
      amount: "10000",
    });
  });

  it("fails without a wallet — settlement needs a gas payer", async () => {
    const result = await exactScheme.settle(await buildPermit2(), permit2Requirements, stubCtx());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.UNEXPECTED_SETTLE_ERROR);
  });

  it("the pre-settle re-verify catches state drained between verify and settle", async () => {
    const result = await exactScheme.settle(
      await buildPermit2(),
      permit2Requirements,
      withWallet(stubCtx({ balance: 1n })),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.INSUFFICIENT_FUNDS);
  });

  it("a mined-but-REVERTED settlement is a failure, never success (no free goods)", async () => {
    // The tx broadcasts (simulate passed at re-verify) but reverts on inclusion —
    // e.g. the payer front-ran a Permit2 nonce invalidation. Must NOT report success.
    const result = await exactScheme.settle(
      await buildPermit2(),
      permit2Requirements,
      withWallet(stubCtx({ receiptReverted: true })),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrorReason.INVALID_TRANSACTION_STATE);
    // a definite failure, NOT pending — the tx is mined and final
    expect(result.errorReason).not.toBe(ErrorReasonExtra.SETTLEMENT_PENDING);
  });
});
