/**
 * One-time Permit2 setup for a token — the single on-chain transaction the
 * permit2 path needs from a buyer. After this, every payment on that token is
 * signature-only (zero gas), same as EIP-3009.
 *
 * This is deliberately the ONLY buyer-side function that spends gas; keeping
 * it separate from the payment flow makes that boundary visible.
 */

import { maxUint256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { broadcastAndConfirm, ERC20_ABI, PERMIT2_ADDRESS } from "@x402kit/core";

export interface ApprovePermit2Options {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** The ERC-20 to enable for permit2 payments */
  token: Address;
  /**
   * Allowance to grant. Default maxUint256 — the Permit2 convention, since
   * each actual transfer still requires a fresh bounded signature; the
   * allowance only lets Permit2 act on those signatures.
   */
  amount?: bigint;
  /** Override only for private/test deployments. Default: canonical Permit2 */
  permit2Address?: Address;
}

/**
 * Approve the Permit2 contract on a token, skipping the transaction when the
 * current allowance already covers `amount`.
 *
 * The allowance outlives this kit: revoke it with `approvePermit2({ ...,
 * amount: 0n })` is NOT enough (it skips when current >= 0) — call
 * `revokePermit2` instead.
 *
 * @returns the approve tx hash, or undefined when no transaction was needed
 * @throws PendingReceiptError (with the tx hash) when the approve was
 *   broadcast but its receipt did not arrive in time — check on-chain before
 *   resubmitting
 */
export async function approvePermit2(opts: ApprovePermit2Options): Promise<Hex | undefined> {
  const account = opts.walletClient.account;
  if (!account) throw new Error("approvePermit2 needs a walletClient with an account");
  const permit2 = opts.permit2Address ?? PERMIT2_ADDRESS;
  const amount = opts.amount ?? maxUint256;

  // An allowance is only as safe as its spender. Whatever address ends up here
  // (a config value, a typo, a wire value someone plumbed through) must hold
  // contract code — an approve to a codeless address is a gift to whoever
  // deploys there later.
  const code = await opts.publicClient.getCode({ address: permit2 });
  if (code === undefined || code === "0x") {
    throw new Error(`no contract at Permit2 address ${permit2} on this chain — refusing to approve`);
  }

  const current = await opts.publicClient.readContract({
    address: opts.token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, permit2],
  });
  if (current >= amount) return undefined;

  return broadcastAndConfirm(opts.publicClient, opts.walletClient, {
    address: opts.token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [permit2, amount],
    account,
    chain: opts.walletClient.chain ?? null,
  });
}

/** Set the Permit2 allowance on a token back to zero — the undo for approvePermit2 */
export async function revokePermit2(opts: Omit<ApprovePermit2Options, "amount">): Promise<Hex> {
  const account = opts.walletClient.account;
  if (!account) throw new Error("revokePermit2 needs a walletClient with an account");
  const permit2 = opts.permit2Address ?? PERMIT2_ADDRESS;
  return broadcastAndConfirm(opts.publicClient, opts.walletClient, {
    address: opts.token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [permit2, 0n],
    account,
    chain: opts.walletClient.chain ?? null,
  });
}
