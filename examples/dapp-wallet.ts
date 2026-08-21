/**
 * Recipe: pay from a browser dapp with a connected wallet.
 *
 * This is the one piece the READMEs assume you know: adapting a browser wallet
 * (MetaMask, Rabby, WalletConnect — whatever wagmi/viem hands you) to the kit's
 * `PaymentSigner`. The buyer signs an EIP-712 permission (no gas, no
 * "confirm transaction" popup); the facilitator submits the on-chain tx.
 *
 * Unlike the other examples this one is browser code, so it is TYPE-CHECKED
 * here but run inside your own dapp. See docs/dapp-guide.md for the full walk.
 */

import type { Account, WalletClient } from "viem";
import type { PaymentSigner } from "@x402kit/core";
import { wrapFetch } from "@x402kit/buyer";

/**
 * The whole adapter: a viem wallet client already signs typed data — its method
 * just takes the account alongside the payload, so this is a shape change.
 */
export function walletSigner(wallet: WalletClient, account: Account | `0x${string}`): PaymentSigner {
  const address = typeof account === "string" ? account : account.address;
  return {
    address,
    signTypedData: (typedData) => wallet.signTypedData({ account, ...typedData }),
  };
}

/**
 * Build a payment-aware fetch for the connected wallet. Gate your "Pay" button
 * on the returned value being defined (i.e. a wallet is connected), and keep
 * the call behind a user gesture so the signature popup has one to attach to.
 */
export function makePayFetch(
  wallet: WalletClient,
  account: `0x${string}`,
  opts: { maxAmount: string; assets: `0x${string}`[] },
): typeof fetch {
  return wrapFetch(fetch, {
    signer: walletSigner(wallet, account),
    maxAmount: opts.maxAmount, // hard cap — never signs above this
    assets: opts.assets, // required token allowlist (maxAmount is token-blind)
    onSkipped: (reason) => console.warn("payment skipped:", reason), // refusals don't throw
  });
}

/*
  In a wagmi component:

    import { useWalletClient, useAccount } from "wagmi";

    function PayButton() {
      const { address } = useAccount();
      const { data: wallet } = useWalletClient();
      if (!wallet || !address) return <ConnectButton />;

      const pay = makePayFetch(wallet, address, { maxAmount: "5000000", assets: [USDC] });
      return <button onClick={() => pay("/api/premium")}>Pay & fetch</button>;
    }

  For a token that needs Permit2 (no EIP-3009), run the one-time approve first:

    import { approvePermit2 } from "@x402kit/buyer";
    await approvePermit2({ walletClient: wallet, publicClient, token: USDC });
*/
