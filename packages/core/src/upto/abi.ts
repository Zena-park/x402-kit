/**
 * x402UptoPermit2Proxy — `settle(permit, amount, owner, witness, signature)`.
 * Reverts AmountExceedsPermitted when amount > permitted.amount and
 * UnauthorizedFacilitator when msg.sender != witness.facilitator.
 * Selector 0xff11e7b4 (verified against the Base mainnet bytecode vendored
 * in e2e/bytecode).
 */
export const X402_UPTO_PERMIT2_PROXY_ABI = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "amount", type: "uint256" },
      { name: "owner", type: "address" },
      {
        name: "witness",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "facilitator", type: "address" },
          { name: "validAfter", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;
