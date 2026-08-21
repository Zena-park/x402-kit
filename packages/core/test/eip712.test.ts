import { describe, expect, it } from "vitest";
import { keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { buildTransferDigest, buildTransferTypedData, exactScheme } from "../src/index.js";
import { domainFor, specPaymentPayload, specRequirements, testAccount } from "./fixtures.js";

/** USDC FiatTokenV2's TRANSFER_WITH_AUTHORIZATION_TYPEHASH — must match the on-chain constant byte-for-byte */
const USDC_TRANSFER_TYPEHASH = "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

const TYPE_STRING =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

describe("exact's EIP-712 — byte-identical to USDC", () => {
  it("the type string hashes to USDC's on-chain typehash", () => {
    expect(keccak256(toBytes(TYPE_STRING))).toBe(USDC_TRANSFER_TYPEHASH);
  });

  it("the digest is deterministic — same input, same value", () => {
    const domain = domainFor(specRequirements);
    const auth = specPaymentPayload.payload.authorization;
    expect(buildTransferDigest(domain, auth)).toBe(buildTransferDigest(domain, auth));
  });

  it("a buildPayload signature recovers to the signer address (EOA round trip)", async () => {
    const payload = await exactScheme.buildPayload(specRequirements, { signer: testAccount });

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(specRequirements);
    expect(payload.payload.authorization.from).toBe(testAccount.address);
    expect(payload.payload.authorization.to).toBe(specRequirements.payTo);
    expect(payload.payload.authorization.value).toBe(specRequirements.amount);

    const recovered = await recoverTypedDataAddress({
      ...buildTransferTypedData(domainFor(specRequirements), payload.payload.authorization),
      signature: payload.payload.signature,
    });
    expect(recovered).toBe(testAccount.address);
  });

  it("concurrent payments never block each other — nonces are random", async () => {
    const [a, b] = await Promise.all([
      exactScheme.buildPayload(specRequirements, { signer: testAccount }),
      exactScheme.buildPayload(specRequirements, { signer: testAccount }),
    ]);
    expect(a.payload.authorization.nonce).not.toBe(b.payload.authorization.nonce);
  });
});
