/**
 * Shared connection info for the runnable examples — points at the local world
 * (anvil + facilitator + TestToken) that examples/run.sh boots. In your own
 * project these are just your real RPC, facilitator URL, token, and account.
 */

import { createPublicClient, createWalletClient, formatUnits, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "@x402.kit/core";

export const RPC = "http://127.0.0.1:8545";
export const FACILITATOR = "http://127.0.0.1:4021";
export const NETWORK = "eip155:31337" as const;
export const TOKEN = process.env.TOKEN_ADDRESS as Address; // a plain ERC-20 (permit2 path)
export const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address; // anvil #2

// The buyer — anvil #1. Signs only (plus the one-time Permit2 approve).
export const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

export const publicClient = createPublicClient({ transport: http(RPC) });
export const buyerWallet = createWalletClient({ account: buyer, transport: http(RPC) });

export const chainNow = async (): Promise<number> => Number((await publicClient.getBlock()).timestamp);
export const balanceOf = (a: Address) =>
  publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
export const fmt = (v: bigint) => `${formatUnits(v, 6)} KRW`;
