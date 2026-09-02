// Types (spec §5)
export type {
  Network,
  ResourceInfo,
  Extensions,
  PaymentRequirements,
  PaymentRequired,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
  FacilitatorRequest,
  SupportedResponse,
} from "./types.js";

// Error codes (spec §9, plus documented extras)
export { ErrorReason, ErrorReasonExtra, type ErrorReasonCode } from "./errors.js";

// Wire codec (transports-v2/http.md)
export {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_PAYMENT_RESPONSE,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  decodePaymentRequiredSafe,
  decodePaymentPayloadSafe,
  encodeSettleResponse,
  decodeSettleResponse,
  decodeSettleResponseSafe,
} from "./codec.js";

// Wire codec (transports-v2/mcp.md) — plain-JSON objects in tool results / _meta
export {
  MCP_META_PAYMENT,
  MCP_META_PAYMENT_RESPONSE,
  mcpToolResourceUrl,
  buildMcpPaymentRequired,
  extractMcpPaymentRequired,
  extractMcpPayment,
  attachMcpPayment,
  attachMcpSettleResponse,
  extractMcpSettleResponse,
} from "./mcpCodec.js";
export type { McpToolResult } from "./mcpCodec.js";

// Runtime validation (zod) — spec-exact, stricter on amount/network
export {
  PaymentRequirementsSchema,
  PaymentRequiredSchema,
  PaymentPayloadSchema,
  FacilitatorRequestSchema,
  AmountSchema,
  AddressSchema,
  NetworkSchema,
  parsePaymentRequired,
  parsePaymentPayload,
  parseFacilitatorRequest,
  type ParseResult,
} from "./schemas.js";

// ERC-6492 (parsing delegated to viem; adapter into the kit's vocabulary)
export { isErc6492Signature, parseErc6492Signature, type Erc6492Signature } from "./erc6492.js";

// Shared utilities
export { sameAddress, matchesNetwork, caip2ChainId, parseAmount, canonicalAddress, canonicalNonce, hasCode, nowSeconds } from "./utils.js";

// Scheme extension point
export {
  createSchemeRegistry,
  checkEnvelope,
  matchesRequirements,
  selectRequirements,
  resolveHandler,
  settleGasLimit,
  settlerAccount,
  configuredSettler,
  validateChainContext,
  DEFAULT_MAX_SETTLE_GAS,
  DEFAULT_MAX_ERC6492_SETTLE_GAS,
  DEFAULT_MIN_REMAINING_VALIDITY_SECONDS,
  requiredRemainingValidity,
  settlementLedger,
  type SettlementLedger,
  type PaymentSigner,
  type ChainContext,
  type BuildPayloadOptions,
  type SchemeHandler,
  type AnySchemeHandler,
  type SchemeRegistry,
} from "./scheme.js";

// The exact scheme (built in) — eip3009 and permit2 asset transfer methods
export { exactScheme } from "./exact/handler.js";
export type {
  AnyExactPayload,
  Eip3009Authorization,
  ExactPayload,
  ExactPermit2Payload,
  Permit2Authorization,
} from "./exact/types.js";
export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildTransferTypedData,
  buildTransferDigest,
  type Eip712DomainParams,
} from "./exact/eip712.js";
export {
  PERMIT2_ADDRESS,
  X402_PERMIT2_PROXY_ADDRESS,
  PERMIT2_WITNESS_TRANSFER_TYPES,
  PERMIT2_WITNESS_TYPE_STRING,
  buildPermit2TypedData,
  buildPermit2Digest,
  type Permit2DomainParams,
} from "./exact/permit2Eip712.js";
export { isPermit2Payload } from "./exact/permit2.js";
export { findExternalSettlement, settleAndReconcile, type ExternalSettlementQuery, type SignedTransfer } from "./exact/reconcile.js";
export {
  EIP3009_TOKEN_ABI,
  ERC20_ABI,
  ERC6492_SETTLER_ABI,
  PERMIT2_ABI,
  X402_PERMIT2_PROXY_ABI,
} from "./exact/abi.js";

// The upto scheme (built in) — sign a cap, settle the actual (Permit2 only)
export { uptoScheme, isUptoPayload } from "./upto/handler.js";
export type { UptoPayload, UptoPermit2Authorization, UptoPermit2Witness } from "./upto/types.js";
export {
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  UPTO_PERMIT2_WITNESS_TRANSFER_TYPES,
  UPTO_PERMIT2_WITNESS_TYPE_STRING,
  buildUptoTypedData,
  buildUptoDigest,
} from "./upto/eip712.js";
export { X402_UPTO_PERMIT2_PROXY_ABI } from "./upto/abi.js";

// Shared Permit2 core (exact/permit2 and upto both build on it)
export {
  wellFormedPermit2,
  parsePermit2Fields,
  permit2Contract,
  permit2PermitArg,
  permit2InnerSignature,
  checkPermit2State,
  type Permit2AuthorizationBase,
  type Permit2Fields,
  type Permit2StateQuery,
  type Permit2StateVerdict,
} from "./permit2Common.js";

// Shared EVM helpers
export { resolveDomain } from "./domain.js";
export { broadcastAndConfirm, PendingReceiptError, SettlementRevertedError } from "./settleTx.js";

// Low-level 402 builder (for non-HTTP transports such as POS/QR)
export { buildPaymentRequired, type PaymentRequiredParams } from "./paymentRequired.js";
