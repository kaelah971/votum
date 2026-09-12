import { normalizeAddress } from "@/lib/nimiq/server-crypto";

/** The finality states a trusted server-side observation may report. */
export type FundingFinality = "final" | "not_final" | "unknown";

export type FundingFinalityReason =
  | "observed_not_final"
  | "canonical_block_mismatch"
  | "finality_unknown";

export interface FundingFinalityEvidence {
  transactionBlockHeight: number | null;
  transactionBlockHash: string | null;
  canonicalBlockHash: string | null;
  canonicalBlockVerified: boolean;
  batchNumber: number | null;
  finalizingMacroBlockHeight: number | null;
  finalizingMacroBlockHash: string | null;
}

/** Server-authoritative funding facts loaded from the funding record. */
export interface ExpectedFunding {
  campaignId?: string;
  fundingIntentId?: string;
  networkId: number;
  transactionHash: string;
  vaultAddress: string;
  amountLuna: bigint;
  /** Required only when the funding intent has a memo/data requirement. */
  memo?: string;
}

/** Chain facts normalized by the Nimiq observation adapter. */
export interface ObservedFundingTransaction {
  transactionHash: string;
  /** Optional because the current getTransactionByHash response omits it. */
  blockHash: string | null;
  networkId: number | null;
  sender: string | null;
  recipient: string;
  valueLuna: bigint;
  memo: string | null;
  executionResult: boolean | null;
  blockHeight: number | null;
  timestampMs: number | null;
  confirmationCount: number | null;
  /** Unknown is intentional until a network finality policy is proven. */
  finality: FundingFinality;
  finalityReason: FundingFinalityReason | null;
  finalityEvidence: FundingFinalityEvidence | null;
}

export type FundingObservation =
  | { kind: "found"; transaction: ObservedFundingTransaction }
  | { kind: "not_found" }
  | { kind: "rpc_error"; code: "rpc_unavailable" | "rpc_timeout" }
  | { kind: "malformed"; reasonCode: "malformed_transaction" };

/** Server-authoritative payout facts loaded from the receipt and campaign vault. */
export interface ExpectedPayout {
  campaignId?: string;
  receiptId?: string;
  attemptId?: string;
  networkId: number;
  transactionHash: string;
  vaultAddress: string;
  participantWallet: string;
  amountLuna: bigint;
}

/** Server-authoritative refund facts loaded from the refund record. */
export interface ExpectedRefund {
  campaignId?: string;
  refundId?: string;
  networkId: number;
  transactionHash: string;
  vaultAddress: string;
  creatorWallet: string;
  amountLuna: bigint;
}

export const PAYOUT_RECONCILIATION_STATUSES = [
  "pending",
  "confirmed",
  "retryable",
  "rejected",
  "unknown",
] as const;

export type PayoutReconciliationStatus =
  (typeof PAYOUT_RECONCILIATION_STATUSES)[number];

export const PAYOUT_RECONCILIATION_REASON_CODES = [
  "transaction_not_found_yet",
  "rpc_unavailable",
  "rpc_timeout",
  "wrong_network",
  "network_unknown",
  "hash_mismatch",
  "wrong_sender",
  "wrong_recipient",
  "amount_underpaid",
  "amount_exact",
  "amount_overpaid",
  "canonical_block_mismatch",
  "execution_failed",
  "execution_unknown",
  "observed_but_not_final",
  "finality_unknown",
  "confirmed_success",
  "malformed_transaction",
 ] as const;

export type PayoutReconciliationReasonCode =
  (typeof PAYOUT_RECONCILIATION_REASON_CODES)[number];

export interface PayoutReconciliationResult {
  status: PayoutReconciliationStatus;
  reasonCode: PayoutReconciliationReasonCode;
  confirmed: boolean;
  campaignId?: string;
  receiptId?: string;
  attemptId?: string;
  expectedTransactionHash: string;
  observedTransactionHash: string | null;
  expectedSender: string;
  observedSender: string | null;
  expectedRecipient: string;
  observedRecipient: string | null;
  expectedAmountLuna: bigint;
  observedAmountLuna: bigint | null;
  amountComparison: FundingAmountComparison;
}

export interface RefundReconciliationResult {
  status: PayoutReconciliationStatus;
  reasonCode: PayoutReconciliationReasonCode;
  confirmed: boolean;
  campaignId?: string;
  refundId?: string;
  expectedTransactionHash: string;
  observedTransactionHash: string | null;
  expectedSender: string;
  observedSender: string | null;
  expectedRecipient: string;
  observedRecipient: string | null;
  expectedAmountLuna: bigint;
  observedAmountLuna: bigint | null;
  amountComparison: FundingAmountComparison;
}

export const FUNDING_RECONCILIATION_STATUSES = [
  "pending",
  "confirmed",
  "retryable",
  "rejected",
  "unknown",
] as const;

export type FundingReconciliationStatus =
  (typeof FUNDING_RECONCILIATION_STATUSES)[number];

export const FUNDING_RECONCILIATION_REASON_CODES = [
  "transaction_not_found_yet",
  "rpc_unavailable",
  "rpc_timeout",
  "wrong_network",
  "network_unknown",
  "hash_mismatch",
  "wrong_recipient",
  "amount_underpaid",
  "amount_exact",
  "amount_overpaid",
  "canonical_block_mismatch",
  "memo_mismatch",
  "memo_unknown",
  "execution_failed",
  "execution_unknown",
  "observed_but_not_final",
  "finality_unknown",
  "confirmed_success",
  "malformed_transaction",
] as const;

export type FundingReconciliationReasonCode =
  (typeof FUNDING_RECONCILIATION_REASON_CODES)[number];

export type FundingAmountComparison =
  | "unknown"
  | "underpaid"
  | "exact"
  | "overpaid";

export interface FundingReconciliationResult {
  status: FundingReconciliationStatus;
  reasonCode: FundingReconciliationReasonCode;
  confirmed: boolean;
  campaignId?: string;
  fundingIntentId?: string;
  expectedTransactionHash: string;
  observedTransactionHash: string | null;
  expectedAmountLuna: bigint;
  observedAmountLuna: bigint | null;
  excessAmountLuna: bigint;
  amountComparison: FundingAmountComparison;
}

function isTransactionHash(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

export function hasFinalityEvidence(observed: ObservedFundingTransaction): boolean {
  const evidence = observed.finalityEvidence;
  return evidence !== null &&
    evidence.canonicalBlockVerified &&
    evidence.transactionBlockHeight === observed.blockHeight &&
    evidence.canonicalBlockHash !== null &&
    isTransactionHash(evidence.canonicalBlockHash) &&
    (observed.blockHash === null ||
      observed.blockHash.trim().toLowerCase() === evidence.canonicalBlockHash.trim().toLowerCase()) &&
    (evidence.transactionBlockHash === null ||
      observed.blockHash !== null &&
      evidence.transactionBlockHash.trim().toLowerCase() === observed.blockHash.trim().toLowerCase()) &&
    evidence.batchNumber !== null &&
    evidence.finalizingMacroBlockHeight !== null &&
    observed.blockHeight !== null &&
    evidence.finalizingMacroBlockHeight >= observed.blockHeight &&
    evidence.finalizingMacroBlockHash !== null &&
    isTransactionHash(evidence.finalizingMacroBlockHash);
}

function baseResult(expected: ExpectedFunding): FundingReconciliationResult {
  return {
    status: "unknown",
    reasonCode: "malformed_transaction",
    confirmed: false,
    campaignId: expected.campaignId,
    fundingIntentId: expected.fundingIntentId,
    expectedTransactionHash: expected.transactionHash.toLowerCase(),
    observedTransactionHash: null,
    expectedAmountLuna: expected.amountLuna,
    observedAmountLuna: null,
    excessAmountLuna: BigInt(0),
    amountComparison: "unknown",
  };
}

function withDecision(
  expected: ExpectedFunding,
  decision: Pick<FundingReconciliationResult, "status" | "reasonCode">,
  observed?: ObservedFundingTransaction,
  amountComparison: FundingAmountComparison = "unknown",
): FundingReconciliationResult {
  const result = baseResult(expected);
  result.status = decision.status;
  result.reasonCode = decision.reasonCode;
  result.confirmed = decision.status === "confirmed";
  result.amountComparison = amountComparison;
  if (observed) {
    result.observedTransactionHash = observed.transactionHash.toLowerCase();
    result.observedAmountLuna = observed.valueLuna;
    if (observed.valueLuna > expected.amountLuna) {
      result.excessAmountLuna = observed.valueLuna - expected.amountLuna;
    }
  }
  return result;
}

/**
 * Reconcile one expected funding intent against one server-side observation.
 *
 * This function is deliberately side-effect free. It never changes a campaign,
 * funding row, reward terms, capacity, or any database state.
 */
export function reconcileRewardFunding(
  expected: ExpectedFunding,
  observation: FundingObservation,
): FundingReconciliationResult {
  if (
    !isTransactionHash(expected.transactionHash) ||
    expected.amountLuna < BigInt(0) ||
    !Number.isSafeInteger(expected.networkId)
  ) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    });
  }

  if (observation.kind === "not_found") {
    return withDecision(expected, {
      status: "pending",
      reasonCode: "transaction_not_found_yet",
    });
  }
  if (observation.kind === "rpc_error") {
    return withDecision(expected, {
      status: "retryable",
      reasonCode: observation.code,
    });
  }
  if (observation.kind === "malformed") {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: observation.reasonCode,
    });
  }

  const observed = observation.transaction;
  const resultHash = observed.transactionHash.trim().toLowerCase();
  if (!isTransactionHash(observed.transactionHash)) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    }, observed);
  }
  if (resultHash !== expected.transactionHash.trim().toLowerCase()) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "hash_mismatch",
    }, observed);
  }

  if (observed.networkId === null) {
    return withDecision(expected, {
      status: "unknown",
      reasonCode: "network_unknown",
    }, observed);
  }
  if (observed.networkId !== expected.networkId) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_network",
    }, observed);
  }

  const expectedVault = normalizeAddress(expected.vaultAddress);
  const observedRecipient = normalizeAddress(observed.recipient);
  if (!expectedVault || !observedRecipient) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    }, observed);
  }
  if (expectedVault !== observedRecipient) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_recipient",
    }, observed);
  }

  if (expected.memo !== undefined) {
    if (observed.memo === null) {
      return withDecision(expected, {
        status: "unknown",
        reasonCode: "memo_unknown",
      }, observed);
    }
    if (observed.memo !== expected.memo) {
      return withDecision(expected, {
        status: "rejected",
        reasonCode: "memo_mismatch",
      }, observed);
    }
  }

  if (observed.executionResult === false) {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "execution_failed",
    }, observed);
  }
  if (observed.executionResult !== true) {
    return withDecision(expected, {
      status: "unknown",
      reasonCode: "execution_unknown",
    }, observed);
  }

  const amountComparison: FundingAmountComparison =
    observed.valueLuna < expected.amountLuna
      ? "underpaid"
      : observed.valueLuna === expected.amountLuna
        ? "exact"
        : "overpaid";

  if (amountComparison === "underpaid") {
    return withDecision(expected, {
      status: "rejected",
      reasonCode: "amount_underpaid",
    }, observed, amountComparison);
  }

  if (observed.finality === "not_final") {
    return withDecision(expected, {
      status: "pending",
      reasonCode: observed.finalityReason === "canonical_block_mismatch"
        ? "canonical_block_mismatch"
        : "observed_but_not_final",
    }, observed, amountComparison);
  }
  if (observed.finality !== "final") {
    return withDecision(expected, {
      status: "pending",
      reasonCode: "finality_unknown",
    }, observed, amountComparison);
  }

  if (!hasFinalityEvidence(observed)) {
    return withDecision(expected, {
      status: "pending",
      reasonCode: "finality_unknown",
    }, observed, amountComparison);
  }

  return withDecision(expected, {
    status: "confirmed",
    reasonCode: amountComparison === "overpaid"
      ? "amount_overpaid"
      : "confirmed_success",
  }, observed, amountComparison);
}

function payoutBaseResult(expected: ExpectedPayout): PayoutReconciliationResult {
  return {
    status: "unknown",
    reasonCode: "malformed_transaction",
    confirmed: false,
    campaignId: expected.campaignId,
    receiptId: expected.receiptId,
    attemptId: expected.attemptId,
    expectedTransactionHash: expected.transactionHash.trim().toLowerCase(),
    observedTransactionHash: null,
    expectedSender: expected.vaultAddress,
    observedSender: null,
    expectedRecipient: expected.participantWallet,
    observedRecipient: null,
    expectedAmountLuna: expected.amountLuna,
    observedAmountLuna: null,
    amountComparison: "unknown",
  };
}

function withPayoutDecision(
  expected: ExpectedPayout,
  decision: Pick<PayoutReconciliationResult, "status" | "reasonCode">,
  observed?: ObservedFundingTransaction,
  amountComparison: FundingAmountComparison = "unknown",
): PayoutReconciliationResult {
  const result = payoutBaseResult(expected);
  result.status = decision.status;
  result.reasonCode = decision.reasonCode;
  result.confirmed = decision.status === "confirmed";
  result.amountComparison = amountComparison;
  if (observed) {
    result.observedTransactionHash = observed.transactionHash.trim().toLowerCase();
    result.observedSender = observed.sender;
    result.observedRecipient = observed.recipient;
    result.observedAmountLuna = observed.valueLuna;
  }
  return result;
}

/**
 * Reconcile one stored payout hash against one server-side chain observation.
 * Unlike funding, payout value must be exact: both underpayment and overpayment
 * are rejected. This function is pure and never mutates financial state.
 */
export function reconcileRewardPayout(
  expected: ExpectedPayout,
  observation: FundingObservation,
): PayoutReconciliationResult {
  if (
    !isTransactionHash(expected.transactionHash) ||
    expected.amountLuna <= BigInt(0) ||
    !Number.isSafeInteger(expected.networkId) ||
    expected.networkId < 0
  ) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    });
  }

  if (observation.kind === "not_found") {
    return withPayoutDecision(expected, {
      status: "pending",
      reasonCode: "transaction_not_found_yet",
    });
  }
  if (observation.kind === "rpc_error") {
    return withPayoutDecision(expected, {
      status: "retryable",
      reasonCode: observation.code,
    });
  }
  if (observation.kind === "malformed") {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: observation.reasonCode,
    });
  }

  const observed = observation.transaction;
  const resultHash = observed.transactionHash.trim().toLowerCase();
  if (!isTransactionHash(observed.transactionHash)) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    }, observed);
  }
  if (resultHash !== expected.transactionHash.trim().toLowerCase()) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "hash_mismatch",
    }, observed);
  }

  if (observed.networkId === null) {
    return withPayoutDecision(expected, {
      status: "unknown",
      reasonCode: "network_unknown",
    }, observed);
  }
  if (observed.networkId !== expected.networkId) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_network",
    }, observed);
  }

  const expectedSender = normalizeAddress(expected.vaultAddress);
  const observedSender = observed.sender === null ? null : normalizeAddress(observed.sender);
  const expectedRecipient = normalizeAddress(expected.participantWallet);
  const observedRecipient = normalizeAddress(observed.recipient);
  if (!expectedSender || !expectedRecipient || !observedRecipient || observedSender === null) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
    }, observed);
  }
  if (observedSender !== expectedSender) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_sender",
    }, observed);
  }
  if (observedRecipient !== expectedRecipient) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_recipient",
    }, observed);
  }

  const amountComparison: FundingAmountComparison =
    observed.valueLuna < expected.amountLuna
      ? "underpaid"
      : observed.valueLuna === expected.amountLuna
        ? "exact"
        : "overpaid";
  if (amountComparison !== "exact") {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: amountComparison === "underpaid" ? "amount_underpaid" : "amount_overpaid",
    }, observed, amountComparison);
  }

  if (observed.executionResult === false) {
    return withPayoutDecision(expected, {
      status: "rejected",
      reasonCode: "execution_failed",
    }, observed, amountComparison);
  }
  if (observed.executionResult !== true) {
    return withPayoutDecision(expected, {
      status: "unknown",
      reasonCode: "execution_unknown",
    }, observed, amountComparison);
  }

  if (observed.finality === "not_final") {
    return withPayoutDecision(expected, {
      status: "pending",
      reasonCode: observed.finalityReason === "canonical_block_mismatch"
        ? "canonical_block_mismatch"
        : "observed_but_not_final",
    }, observed, amountComparison);
  }
  if (observed.finality !== "final" || !hasFinalityEvidence(observed)) {
    return withPayoutDecision(expected, {
      status: "pending",
      reasonCode: observed.finalityReason === "canonical_block_mismatch"
        ? "canonical_block_mismatch"
        : "finality_unknown",
    }, observed, amountComparison);
  }

  return withPayoutDecision(expected, {
    status: "confirmed",
    reasonCode: "confirmed_success",
  }, observed, amountComparison);
}

function baseRefundResult(expected: ExpectedRefund): RefundReconciliationResult {
  return {
    status: "unknown",
    reasonCode: "malformed_transaction",
    confirmed: false,
    campaignId: expected.campaignId,
    refundId: expected.refundId,
    expectedTransactionHash: expected.transactionHash.toLowerCase(),
    observedTransactionHash: null,
    expectedSender: normalizeAddress(expected.vaultAddress) ?? expected.vaultAddress,
    observedSender: null,
    expectedRecipient: normalizeAddress(expected.creatorWallet) ?? expected.creatorWallet,
    observedRecipient: null,
    expectedAmountLuna: expected.amountLuna,
    observedAmountLuna: null,
    amountComparison: "unknown",
  };
}

function withRefundDecision(
  expected: ExpectedRefund,
  decision: Pick<RefundReconciliationResult, "status" | "reasonCode" | "confirmed">,
  observed?: ObservedFundingTransaction,
  amountComparison: FundingAmountComparison = "unknown",
): RefundReconciliationResult {
  const result = baseRefundResult(expected);
  return {
    ...result,
    ...decision,
    observedTransactionHash: observed?.transactionHash ?? null,
    observedSender: observed?.sender === null || observed?.sender === undefined
      ? null
      : normalizeAddress(observed.sender),
    observedRecipient: observed ? normalizeAddress(observed.recipient) : null,
    observedAmountLuna: observed?.valueLuna ?? null,
    amountComparison,
  };
}

/**
 * Reconcile one stored refund hash against one server-side chain observation.
 * Refund confirmation uses the same exact-transfer and canonical finality rules
 * as payout confirmation, but never mutates financial state.
 */
export function reconcileRewardRefund(
  expected: ExpectedRefund,
  observation: FundingObservation,
): RefundReconciliationResult {
  if (
    !isTransactionHash(expected.transactionHash) ||
    expected.amountLuna <= BigInt(0) ||
    !Number.isSafeInteger(expected.networkId) ||
    expected.networkId < 0
  ) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
      confirmed: false,
    });
  }

  if (observation.kind === "not_found") {
    return withRefundDecision(expected, {
      status: "pending",
      reasonCode: "transaction_not_found_yet",
      confirmed: false,
    });
  }
  if (observation.kind === "rpc_error") {
    return withRefundDecision(expected, {
      status: "retryable",
      reasonCode: observation.code,
      confirmed: false,
    });
  }
  if (observation.kind === "malformed") {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: observation.reasonCode,
      confirmed: false,
    });
  }

  const observed = observation.transaction;
  const resultHash = observed.transactionHash.trim().toLowerCase();
  if (!isTransactionHash(observed.transactionHash)) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
      confirmed: false,
    }, observed);
  }
  if (resultHash !== expected.transactionHash.trim().toLowerCase()) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "hash_mismatch",
      confirmed: false,
    }, observed);
  }

  if (observed.networkId === null) {
    return withRefundDecision(expected, {
      status: "unknown",
      reasonCode: "network_unknown",
      confirmed: false,
    }, observed);
  }
  if (observed.networkId !== expected.networkId) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_network",
      confirmed: false,
    }, observed);
  }

  const expectedSender = normalizeAddress(expected.vaultAddress);
  const observedSender = observed.sender === null ? null : normalizeAddress(observed.sender);
  const expectedRecipient = normalizeAddress(expected.creatorWallet);
  const observedRecipient = normalizeAddress(observed.recipient);
  if (!expectedSender || !expectedRecipient || !observedRecipient || !observedSender) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "malformed_transaction",
      confirmed: false,
    }, observed);
  }
  if (observedSender !== expectedSender) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_sender",
      confirmed: false,
    }, observed);
  }
  if (observedRecipient !== expectedRecipient) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "wrong_recipient",
      confirmed: false,
    }, observed);
  }

  const amountComparison: FundingAmountComparison =
    observed.valueLuna < expected.amountLuna
      ? "underpaid"
      : observed.valueLuna === expected.amountLuna
        ? "exact"
        : "overpaid";
  if (amountComparison !== "exact") {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: amountComparison === "underpaid" ? "amount_underpaid" : "amount_overpaid",
      confirmed: false,
    }, observed, amountComparison);
  }

  if (observed.executionResult === false) {
    return withRefundDecision(expected, {
      status: "rejected",
      reasonCode: "execution_failed",
      confirmed: false,
    }, observed, amountComparison);
  }
  if (observed.executionResult !== true) {
    return withRefundDecision(expected, {
      status: "unknown",
      reasonCode: "execution_unknown",
      confirmed: false,
    }, observed, amountComparison);
  }

  if (observed.finality === "not_final") {
    return withRefundDecision(expected, {
      status: "pending",
      reasonCode: observed.finalityReason === "canonical_block_mismatch"
        ? "canonical_block_mismatch"
        : "observed_but_not_final",
      confirmed: false,
    }, observed, amountComparison);
  }
  if (observed.finality !== "final" || !hasFinalityEvidence(observed)) {
    return withRefundDecision(expected, {
      status: "pending",
      reasonCode: observed.finalityReason === "canonical_block_mismatch"
        ? "canonical_block_mismatch"
        : "finality_unknown",
      confirmed: false,
    }, observed, amountComparison);
  }

  return withRefundDecision(expected, {
    status: "confirmed",
    reasonCode: "confirmed_success",
    confirmed: true,
  }, observed, amountComparison);
}
