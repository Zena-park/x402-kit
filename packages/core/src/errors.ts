/**
 * Failure reason codes — exactly the codes from spec §9.
 *
 * Codes outside the spec go only into ErrorReasonExtra and must be listed in
 * the conformance doc. Codes stay pure (no detail suffixes) — details belong
 * in server logs.
 */

export const ErrorReason = {
  // ---- spec §9 ----
  INSUFFICIENT_FUNDS: "insufficient_funds",
  EXACT_VALID_AFTER: "invalid_exact_evm_payload_authorization_valid_after",
  EXACT_VALID_BEFORE: "invalid_exact_evm_payload_authorization_valid_before",
  EXACT_VALUE_MISMATCH: "invalid_exact_evm_payload_authorization_value_mismatch",
  EXACT_SIGNATURE: "invalid_exact_evm_payload_signature",
  EXACT_RECIPIENT_MISMATCH: "invalid_exact_evm_payload_recipient_mismatch",
  INVALID_NETWORK: "invalid_network",
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_PAYMENT_REQUIREMENTS: "invalid_payment_requirements",
  INVALID_SCHEME: "invalid_scheme",
  UNSUPPORTED_SCHEME: "unsupported_scheme",
  INVALID_X402_VERSION: "invalid_x402_version",
  INVALID_TRANSACTION_STATE: "invalid_transaction_state",
  UNEXPECTED_VERIFY_ERROR: "unexpected_verify_error",
  UNEXPECTED_SETTLE_ERROR: "unexpected_settle_error",
  // ---- scheme_upto_evm.md §Error codes ----
  /** upto: the settle-time amount exceeds the signed cap */
  UPTO_SETTLEMENT_EXCEEDS_AMOUNT: "invalid_upto_evm_payload_settlement_exceeds_amount",
} as const;

/**
 * Codes not in spec §9. Every addition here must also be registered in the
 * "extensions beyond the spec" list of conformance.ko.md.
 */
export const ErrorReasonExtra = {
  /** EIP-3009 or Permit2 nonce already consumed — replay attempt */
  AUTHORIZATION_ALREADY_USED: "authorization_already_used",

  /**
   * exact/permit2: the payer has not approved (or under-approved) the Permit2
   * contract on this token. The fix is on the buyer's side — a one-time
   * on-chain `approve(Permit2, …)` — so it gets its own code instead of being
   * folded into insufficient_funds.
   */
  PERMIT2_ALLOWANCE_REQUIRED: "permit2_allowance_required",

  /**
   * Transaction was broadcast but no receipt arrived within the timeout. The
   * tx MAY still land — the caller must reconcile on-chain, never blindly
   * resubmit (the nonce is the real guard). A transient, retry-later
   * condition, distinct from a definite failure.
   */
  SETTLEMENT_PENDING: "settlement_pending",

  /**
   * The facilitator is at its in-flight settlement ceiling for this chain.
   * Nothing was broadcast — retry after a short delay (HTTP 503 + retry-after
   * on the turnkey server). A load-shedding answer, never a verdict on the
   * payment itself.
   */
  SETTLE_OVERLOADED: "settle_overloaded",

  // ---- upto (Permit2) verification — the codes the reference implementation
  // emits, reused verbatim so a buyer sees one vocabulary across facilitators ----
  /** upto: witness.facilitator is not this facilitator's settlement address */
  UPTO_FACILITATOR_MISMATCH: "upto_facilitator_mismatch",
  /** upto: Permit2 signature does not recover to `from` */
  PERMIT2_SIGNATURE: "invalid_permit2_signature",
  /** upto: permitted.amount differs from the terms' cap */
  PERMIT2_AMOUNT_MISMATCH: "invalid_permit2_amount_mismatch",
  /** upto: witness.to differs from the terms' payTo */
  PERMIT2_RECIPIENT_MISMATCH: "invalid_permit2_recipient_mismatch",
  /** upto: spender is not the x402UptoPermit2Proxy */
  PERMIT2_SPENDER: "invalid_permit2_spender",
  /** upto: deadline has passed (chain time) */
  PERMIT2_DEADLINE_EXPIRED: "permit2_deadline_expired",
  /** upto: witness.validAfter is still in the future (chain time) */
  PERMIT2_NOT_YET_VALID: "permit2_not_yet_valid",
} as const;

export type ErrorReasonCode =
  | (typeof ErrorReason)[keyof typeof ErrorReason]
  | (typeof ErrorReasonExtra)[keyof typeof ErrorReasonExtra];
