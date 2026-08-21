import { describe, expect, it } from "vitest";
import { serializeErc6492Signature, type Hex } from "viem";
import { isErc6492Signature, parseErc6492Signature } from "../src/index.js";

const FACTORY = "0x1111111111111111111111111111111111111111";
const CALLDATA: Hex = "0xdeadbeef";
const INNER: Hex = `0x${"ab".repeat(65)}`;

describe("ERC-6492 adapter", () => {
  it("unwrapping yields the deployment info and the inner signature", () => {
    const wrapped = serializeErc6492Signature({
      address: FACTORY,
      data: CALLDATA,
      signature: INNER,
    });
    const parsed = parseErc6492Signature(wrapped);
    expect(parsed.wrapped).toBe(true);
    expect(parsed.factory).toBe(FACTORY);
    expect(parsed.factoryCalldata).toBe(CALLDATA);
    expect(parsed.innerSignature).toBe(INNER);
  });

  it("plain signatures pass through unchanged", () => {
    expect(isErc6492Signature(INNER)).toBe(false);
    const parsed = parseErc6492Signature(INNER);
    expect(parsed.wrapped).toBe(false);
    expect(parsed.innerSignature).toBe(INNER);
  });
});
