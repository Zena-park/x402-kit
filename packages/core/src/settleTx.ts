/**
 * Broadcast a settlement and wait for its receipt with a bounded timeout —
 * the crash/disconnect-safety primitive shared by every scheme's settle.
 *
 * The hard part is the ambiguous middle: the tx is broadcast, then the RPC
 * dies (or the block is slow) before a receipt arrives. Blindly resubmitting
 * risks a double settle; hanging forever pins the request and its cache entry.
 * So once the hash is known, EVERY failure to observe a receipt — timeout,
 * transport error, a receipt that belongs to a replacement tx — throws a
 * tagged `PendingReceiptError`: the transaction MAY still land, and the caller
 * must treat it as pending — keep the idempotency entry, reconcile on-chain,
 * never resubmit. The on-chain nonce is the true double-spend guard.
 */

import type { Hex, PublicClient, WalletClient } from "viem";

export class PendingReceiptError extends Error {
  constructor(readonly txHash: Hex) {
    super(`settlement broadcast but receipt not seen before timeout: ${txHash}`);
    this.name = "PendingReceiptError";
  }
}

/** The settlement tx was mined but REVERTED — a definite, final failure (no funds moved) */
export class SettlementRevertedError extends Error {
  constructor(
    readonly txHash: Hex,
    /** Block the reverted tx landed in — lets the caller bound a reconciliation scan */
    readonly blockNumber?: bigint,
  ) {
    super(`settlement transaction reverted on-chain: ${txHash}`);
    this.name = "SettlementRevertedError";
  }
}

export async function broadcastAndConfirm(
  publicClient: PublicClient,
  walletClient: WalletClient,
  request: Parameters<WalletClient["writeContract"]>[0],
  timeoutMs = 60_000,
): Promise<Hex> {
  const txHash = await walletClient.writeContract(request);
  let receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  } catch {
    // The tx is already broadcast (hash known). Whatever went wrong while
    // polling — timeout, ECONNRESET, a 5xx from the provider — the tx is
    // still in flight and MAY land. Reporting a definite failure here would
    // make a seller refuse goods the buyer is about to pay for, and invite a
    // resubmission that double-broadcasts. Always surface it as pending.
    throw new PendingReceiptError(txHash);
  }
  // viem resolves with the REPLACEMENT's receipt when another tx with the same
  // (from, nonce) lands first (repriced / cancelled / a concurrent settle that
  // collided on the nonce). That receipt says nothing about OUR payment — a
  // "success" there would report an unrelated transfer as this settlement.
  // Only a receipt for the hash we broadcast counts; anything else is unknown.
  if (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new PendingReceiptError(txHash);
  }
  // A revert does NOT throw — waitForTransactionReceipt returns a reverted
  // receipt. Without this check a reverted settlement (payer front-ran a nonce
  // invalidation / approve(0) / balance drain, or a token pause landed between
  // simulate and inclusion) would be reported as success and the seller would
  // ship for free. Treat it as a definite failure so the caller returns
  // invalid_transaction_state, NOT pending — the tx is mined and final.
  if (receipt.status !== "success") {
    throw new SettlementRevertedError(txHash, receipt.blockNumber);
  }
  return txHash;
}
