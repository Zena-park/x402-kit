import { getAddress, toHex, type Address, type Hex, type PublicClient } from "viem";

/** 32 random CSPRNG bytes as 0x-hex — the payment-uniqueness primitive behind scheme nonces */
export function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Address comparison — malformed input counts as a mismatch (never throws) */
export function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Parse an atomic-unit amount string safely. Rejects hex, negatives,
 * decimals, and anything above uint256 — so `BigInt()` on wire data can never
 * silently accept "0x10", "-1", or "1e6" (each of which slips past a raw
 * comparison and then corrupts accounting or bypasses a bound).
 *
 * @returns the value, or undefined when the input is not a plain decimal amount
 */
export function parseAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : undefined;
}

/**
 * CAIP-2 pattern match. "eip155:*" covers the whole namespace; anything else
 * must match exactly. Used by schemes to declare their supported networks.
 */
export function matchesNetwork(pattern: string, network: string): boolean {
  if (pattern === network) return true;
  const [ns, ref] = pattern.split(":");
  return ref === "*" && network.startsWith(`${ns}:`);
}

/**
 * CAIP-2 → EVM chainId. Returns undefined for non-eip155 networks — callers
 * decide whether that is an error (facilitator config) or a filter (buyer).
 */
export function caip2ChainId(network: string): number | undefined {
  const [ns, ref] = network.split(":");
  if (ns !== "eip155" || !ref || !/^\d+$/.test(ref)) return undefined;
  return Number(ref);
}

/**
 * One spelling of an address for keys (cache, idempotency, replay): checksum
 * when parseable, lowercased raw otherwise, "" for non-strings. Never throws.
 */
export function canonicalAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/** Is there contract code at `address`? (undefined / "0x" both mean no) */
export async function hasCode(publicClient: PublicClient, address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return code !== undefined && code !== "0x";
}

/** Unix seconds from the wall clock — the one place the division lives */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * bytes32 hex (eip3009) or uint256 decimal (permit2) nonce → one decimal
 * spelling, so the same on-chain nonce yields ONE replay/idempotency id no
 * matter how the wire spells it. Never throws; garbage collapses to "" or its
 * lowercase form.
 */
export function canonicalNonce(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    if (/^0x[0-9a-fA-F]+$/.test(value) || /^\d+$/.test(value)) return BigInt(value).toString();
  } catch {
    /* fall through */
  }
  return value.toLowerCase();
}
