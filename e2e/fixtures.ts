/** Shared e2e wiring — anvil accounts, the token under test, and term builders. */

import { createPublicClient, formatUnits, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI, type FacilitatorRequest, type PaymentRequirements } from "@x402kit/core";

export const RPC = "http://127.0.0.1:8545";
export const FACILITATOR_URL = "http://127.0.0.1:4021";
export const TOKEN = process.env.TOKEN_ADDRESS as Address;
export const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address; // anvil #2

// anvil #1 — the buyer. The private key is used for signing only (never sends a transaction)
export const buyer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

export const publicClient = createPublicClient({ transport: http(RPC) });

/** Sign against chain time — anvil's clock, not the wall clock, is what verify judges by */
export const chainClock = async (): Promise<number> =>
  Number((await publicClient.getBlock()).timestamp);

/** POST one facilitator endpoint — the wire call every scenario makes */
export async function callFacilitator<T>(path: string, body: FacilitatorRequest): Promise<T> {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Balance of the token under test (plain ERC-20 read — works on any token) */
export const balanceOf = (addr: Address) =>
  publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });

/** 6-decimal pretty-printer (1 token = 1 KRW in these fixtures) */
export const krw = (v: bigint) => `${formatUnits(v, 6)} KRW`;

/** Terms in TKRW — the e2e test KRW stablecoin (6 decimals, 1 token = 1 KRW) */
export function wonTerms(amount: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:31337",
    amount,
    asset: TOKEN,
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { name: "Test KRW Stablecoin", version: "1" },
  };
}
