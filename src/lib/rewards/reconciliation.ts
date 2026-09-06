import { normalizeAddress } from "@/lib/nimiq/server-crypto";

/** The finality states a trusted server-side observation may report. */
export type FundingFinality = "final" | "not_final" | "unknown";

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
}

export type FundingObservation =
  | { kind: "found"; transaction: ObservedFundingTransaction }
  | { kind: "not_found" }
  | { kind: "rpc_error"; code: "rpc_unavailable" | "rpc_timeout" }
  | { kind: "malformed"; reasonCode: "malformed_transaction" };

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
      reasonCode: "observed_but_not_final",
    }, observed, amountComparison);
  }
  if (observed.finality !== "final") {
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
