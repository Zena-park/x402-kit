/**
 * Settlement outcome for the exact scheme — broadcast, then turn whatever
 * happened into ONE honest SettleResponse. Shared by the eip3009 and permit2
 * paths, which differ only in how the request is built.
 *
 *   pending   → the tx is in flight (hash known); the caller retains its
 *               idempotency entry and reconciles, never resubmits
 *   reverted  → was the seller paid anyway? Both transfer methods are
 *               permissionless: anyone holding the signature (the buyer, a
 *               mempool watcher) can submit it first, and funds still go to the
 *               signed recipient. Then OUR tx reverts ("authorization used")
 *               although the seller received the exact amount. A consumed
 *               nonce alone is NOT proof (cancelAuthorization /
 *               invalidateUnorderedNonces burn a nonce without moving funds);
 *               the proof is the token's Transfer log from → to for the signed
 *               amount, between the verify-time block and the revert block —
 *               in a transaction not already credited to another payment
 *               (settlementLedger), and, for EIP-3009, one that also emitted
 *               AuthorizationUsed for THIS nonce. Without those two binds a
 *               buyer holding two equal-amount authorizations could let one
 *               settle, cancel the other's nonce so our tx reverts, and have
 *               the first transfer credited twice.
 *               Best-effort: an RPC failure keeps the definite-failure answer.
 */

import type { Address, Hex, WalletClient } from "viem";
import { ErrorReason, ErrorReasonExtra } from "../errors.js";
import { settlementLedger, type ChainContext } from "../scheme.js";
import { broadcastAndConfirm, PendingReceiptError, SettlementRevertedError } from "../settleTx.js";
import type { Network, SettleResponse } from "../types.js";
import { AUTHORIZATION_USED_EVENT, TRANSFER_EVENT } from "./abi.js";

export interface ExternalSettlementQuery {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  /** EIP-3009 only: the tx must also have consumed THIS nonce (AuthorizationUsed) */
  eip3009Nonce?: Hex | undefined;
}

/**
 * @returns the hash of the transaction that carried the signed transfer, or
 *   undefined when no such transfer is visible in the range. A hash already
 *   credited to another payment is never returned; the caller claims the
 *   returned one.
 */
export async function findExternalSettlement(
  ctx: ChainContext,
  q: ExternalSettlementQuery,
): Promise<Hex | undefined> {
  if (q.toBlock < q.fromBlock) return undefined;
  const ledger = settlementLedger(ctx);
  try {
    const range = { fromBlock: q.fromBlock, toBlock: q.toBlock };
    const [transfers, used] = await Promise.all([
      ctx.publicClient.getLogs({ address: q.token, event: TRANSFER_EVENT, args: { from: q.from, to: q.to }, ...range }),
      q.eip3009Nonce
        ? ctx.publicClient.getLogs({
            address: q.token,
            event: AUTHORIZATION_USED_EVENT,
            args: { authorizer: q.from, nonce: q.eip3009Nonce },
            ...range,
          })
        : Promise.resolve(undefined),
    ]);
    const consumedIn = used && new Set(used.map((l) => l.transactionHash));
    return transfers.find(
      (l) => l.args.value === q.amount && !ledger.has(l.transactionHash) && (!consumedIn || consumedIn.has(l.transactionHash)),
    )?.transactionHash;
  } catch {
    return undefined;
  }
}

/** The transfer a signed exact payment authorizes — what reconciliation looks for */
export interface SignedTransfer {
  token: Address;
  from: Address;
  to: Address;
  /** Atomic-unit decimal string, as on the wire */
  amount: string;
  /** EIP-3009 path: the signed nonce, so an external match must have consumed it */
  eip3009Nonce?: Hex | undefined;
}

export async function settleAndReconcile(
  ctx: ChainContext,
  wallet: WalletClient,
  request: Parameters<WalletClient["writeContract"]>[0],
  transfer: SignedTransfer,
  network: Network,
  /** Block height observed by the pre-settle verify — lower bound for the scan */
  verifiedAtBlock: bigint | undefined,
): Promise<SettleResponse> {
  const payer = transfer.from;
  const ledger = settlementLedger(ctx);
  const success = (transaction: Hex): SettleResponse => {
    ledger.add(transaction);
    return { success: true, transaction, network, payer, amount: transfer.amount };
  };
  try {
    return success(await broadcastAndConfirm(ctx.publicClient, wallet, request, ctx.receiptTimeoutMs));
  } catch (e) {
    if (e instanceof PendingReceiptError) {
      // Carry the intended amount so a later reconciliation can report it
      return { success: false, errorReason: ErrorReasonExtra.SETTLEMENT_PENDING, transaction: e.txHash, network, payer, amount: transfer.amount };
    }
    if (e instanceof SettlementRevertedError && verifiedAtBlock !== undefined && e.blockNumber !== undefined) {
      const external = await findExternalSettlement(ctx, {
        token: transfer.token,
        from: transfer.from,
        to: transfer.to,
        eip3009Nonce: transfer.eip3009Nonce,
        amount: BigInt(transfer.amount),
        fromBlock: verifiedAtBlock,
        toBlock: e.blockNumber,
      });
      if (external) return success(external);
    }
    return { success: false, errorReason: ErrorReason.INVALID_TRANSACTION_STATE, transaction: "", network, payer };
  }
}
