/**
 * The local world every chapter connects to — the anvil chain, facilitator,
 * and TestToken that playground/run.sh (via e2e/harness.sh) has booted.
 * Deliberately just a handful of constants and helpers so the chapter files
 * stay readable (and deliberately NOT importing e2e/fixtures — the playground
 * reads as a self-contained document).
 */

import { createPublicClient, createTestClient, createWalletClient, formatUnits, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "@x402.kit/core";

export const RPC = "http://127.0.0.1:8545";
export const FACILITATOR = "http://127.0.0.1:4021"; // @x402.kit/facilitator — /verify /settle
export const TOKEN = process.env.TOKEN_ADDRESS as Address; // any ERC-20 works — EIP-3009 not required
export const SELLER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address; // anvil #2
export const NETWORK = "eip155:31337" as const;

// The buyer — anvil #1. This key only SIGNS (no transactions besides the one-time Permit2 approve)
export const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

export const publicClient = createPublicClient({ transport: http(RPC) });
export const buyerWallet = createWalletClient({ account: buyer, transport: http(RPC) });
export const anvil = createTestClient({ mode: "anvil", transport: http(RPC) }); // time warping (demo only)

export const chainNow = async (): Promise<number> => Number((await publicClient.getBlock()).timestamp);
export const balanceOf = (a: Address) =>
  publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
export const krw = (v: bigint) => `${formatUnits(v, 6)} KRW`;

export function act(title: string): void {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}
