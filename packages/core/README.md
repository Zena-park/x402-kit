# @x402kit/core

x402 v2 protocol core: spec-exact types, the base64 wire codec, the pluggable
`SchemeHandler` interface, and two built-in schemes — `exact` (a fixed price;
EIP-3009 tokens and, via Permit2 with `extra.assetTransferMethod: "permit2"`,
any plain ERC-20) and `upto` (sign a cap, settle the actual; Permit2 only, the
witness binds the facilitator). Both share one Permit2 core (`permit2Common`).
EOA, ERC-1271 smart accounts, and ERC-6492 undeployed accounts alike. Runtime dependency:
viem only. No HTTP, no framework — transports live in the presets.

```ts
import { buildPaymentRequired, exactScheme, encodePaymentRequired } from "@x402kit/core";

// A POS terminal: put the 402 terms in a QR, no HTTP server involved
const required = buildPaymentRequired({
  resource: { url: "pos://store-7/item/42" },
  accepts: [{
    scheme: "exact", network: "eip155:8453", amount: "4500000",
    asset: TOKEN, payTo: STORE, maxTimeoutSeconds: 60,
    extra: { name: "My Token", version: "1" },
  }],
});
showQr(encodePaymentRequired(required));

// Custom schemes plug in through the same interface exact uses
import type { SchemeHandler } from "@x402kit/core";
```

Most integrators want a preset instead: `@x402kit/seller` (middleware),
`@x402kit/buyer` (fetch wrapper), `@x402kit/facilitator` (server).
