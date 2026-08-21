/**
 * Term builders that fill in the parts a seller shouldn't have to hand-write.
 *
 * The friction today: `exact`/eip3009 `accepts` entries need
 * `extra.name`/`extra.version` (the token's EIP-712 domain), and getting them
 * wrong is a construction-time throw. `erc3009Terms` reads them straight off
 * the token contract (ERC-5267 `eip712Domain()`), so a seller writes only the
 * economically meaningful fields. `permit2Terms` covers the (majority of)
 * tokens without EIP-3009 — no domain needed at all.
 */

import { getContract, type Address, type PublicClient } from "viem";
import type { Network, PaymentRequirements } from "@x402kit/core";

const EIP5267_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

/** Read a token's EIP-712 domain name/version via ERC-5267 `eip712Domain()` */
export async function readTokenDomain(
  publicClient: PublicClient,
  asset: Address,
): Promise<{ name: string; version: string }> {
  const token = getContract({ address: asset, abi: EIP5267_ABI, client: publicClient });
  const [, name, version] = await token.read.eip712Domain();
  return { name, version };
}

/** The economically meaningful fields every terms builder shares */
interface BaseTermsInput {
  network: Network;
  asset: Address;
  payTo: Address;
  /** Atomic-unit amount */
  amount: string;
  maxTimeoutSeconds?: number;
}

/** The single place the PaymentRequirements literal (and its defaults) lives */
function baseTerms(input: BaseTermsInput, scheme: string, extra: Record<string, unknown>): PaymentRequirements {
  return {
    scheme,
    network: input.network,
    amount: input.amount,
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
    extra,
  };
}

export interface Erc3009TermsInput extends BaseTermsInput {
  /** Provide a client to auto-read the EIP-712 domain, or pass `extra` yourself */
  publicClient?: PublicClient;
  /** Extra fields to merge. name/version auto-filled if omitted */
  extra?: Record<string, unknown>;
  /** Scheme name for the entry. Default "exact"; custom schemes may reuse the builder */
  scheme?: string;
}

/**
 * Build a PaymentRequirements entry, auto-filling the EIP-712 domain from the
 * token when a `publicClient` is given.
 *
 *   const terms = await erc3009Terms({ network, asset, payTo, amount: "10000", publicClient });
 *   app.use(paywall({ accepts: [terms], facilitator }));
 */
export async function erc3009Terms(input: Erc3009TermsInput): Promise<PaymentRequirements> {
  let domain = { name: input.extra?.name as string | undefined, version: input.extra?.version as string | undefined };
  if ((!domain.name || !domain.version) && input.publicClient) {
    domain = await readTokenDomain(input.publicClient, input.asset);
  }
  if (!domain.name || !domain.version) {
    throw new Error("erc3009Terms needs the token EIP-712 domain — pass a publicClient or extra.name/extra.version");
  }
  return baseTerms(input, input.scheme ?? "exact", { ...input.extra, name: domain.name, version: domain.version });
}

export interface Permit2TermsInput extends BaseTermsInput {
  /** Extra fields to merge. assetTransferMethod is always forced to "permit2" */
  extra?: Record<string, unknown>;
}

/**
 * Build `exact` terms settled through Permit2 — for the majority of tokens
 * that lack EIP-3009. No token EIP-712 domain is needed (the signature
 * verifies against Permit2's own domain), so this is synchronous and needs no
 * client. The buyer must have a one-time `approve(Permit2, …)` on the token.
 *
 *   const terms = permit2Terms({ network, asset, payTo, amount: "10000" });
 *   app.use(paywall({ accepts: [terms], facilitator }));
 */
export function permit2Terms(input: Permit2TermsInput): PaymentRequirements {
  return baseTerms(input, "exact", { ...input.extra, assetTransferMethod: "permit2" });
}

export interface UptoTermsInput extends Omit<BaseTermsInput, "amount"> {
  /** The CAP (atomic units) the buyer pre-authorizes. Settle any amount ≤ this, once */
  maxAmount: string;
  /**
   * The facilitator's settlement address — read it from the facilitator's
   * `/supported` (`kinds[].extra.facilitatorAddress`). The buyer binds it into
   * the signature, so only that facilitator can draw on the cap.
   */
  facilitatorAddress: Address;
  /** Extra fields to merge. assetTransferMethod is always forced to "permit2" */
  extra?: Record<string, unknown>;
}

/**
 * Build `upto` terms — sign a cap, settle the actual. Permit2 only, so any
 * ERC-20 works and the buyer needs the same one-time `approve(Permit2, …)` as
 * exact/permit2. Pair it with `settle: "after-handler"` and
 * `capture({ amount })` (or the `Settlement-Overrides` response header) to
 * charge the real figure once the handler knows it.
 *
 *   const terms = uptoTerms({ network, asset, payTo, maxAmount: "5000000", facilitatorAddress });
 */
export function uptoTerms(input: UptoTermsInput): PaymentRequirements {
  const { maxAmount, facilitatorAddress, extra, ...rest } = input;
  return baseTerms({ ...rest, amount: maxAmount }, "upto", {
    ...extra,
    assetTransferMethod: "permit2",
    facilitatorAddress,
  });
}
