# Examples

Minimal, copy-pasteable recipes — one file per use case, each showing just that
one thing. Start from the file closest to what you're building.

> Looking for a guided tour instead? `playground/` runs the same flows as one
> narrated story (online payment → POS → subscription) end to end. These
> examples are the opposite: isolated starting points, not a walkthrough.

| File | Use case | Runnable |
|---|---|---|
| `seller-paid-api.ts` | A paid API + an agent that pays for it (`withPaywall` · `wrapFetch`) | ✅ |
| `metered-api.ts` | A usage-metered API — `upto`: the buyer signs a cap, the handler sets `Settlement-Overrides`, the actual is settled | ✅ |
| `pos-terminal.ts` | In-person POS — authorize (`verify`) / capture (`settle`) split, 402-as-QR | ✅ |
| `subscription.ts` | Fixed subscription / installments via pre-signed schedules | ✅ |
| `paid-mcp-tool.ts` | A paid MCP tool — an agent pays per tool call (`paidTool` · `wrapMcpClient`) | ✅ |
| `dapp-wallet.ts` | Browser wallet → `PaymentSigner` adapter (wagmi/viem) | type-checked (browser) |
| `self-host-facilitator.ts` | Embed your own facilitator (`createFacilitator`) | type-checked (needs a real RPC + key) |

## Run

```bash
# requirements: Node 20+, foundry (anvil/cast/forge)
npm install
examples/run.sh                 # runs the four runnable examples
examples/run.sh subscription    # just one
```

`run.sh` boots a local world (anvil + the canonical Permit2 contracts + an
in-repo TestToken + the facilitator) and runs the examples against it. The two
type-checked-only examples (`dapp-wallet`, `self-host-facilitator`) are browser
/ real-deployment code — read them and drop them into your own project.

## Notes

- The demo token takes x402's **permit2** transfer method, so a plain ERC-20
  works — that's why every example calls `approvePermit2` once. Tokens with
  EIP-3009 (e.g. USDC) skip that step. `upto` (metered-api) is Permit2-only.
- `maxAmount` **and** `assets` are both required on the buyer — `maxAmount`
  alone is token-blind. See `docs/dapp-guide.md` for the full browser story and
  `packages/*/README.md` for every option.
