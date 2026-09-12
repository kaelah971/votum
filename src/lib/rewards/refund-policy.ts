import type {
  RewardCampaignState,
  RewardPayoutAttemptState,
  RewardReceiptState,
} from "@/lib/rewards/states";

const ZERO_LUNA = BigInt(0);

export type RewardClosureTrigger = "poll_closed" | "expired" | "cancelled";

export interface RewardClosureCampaign {
  status: RewardCampaignState;
  participationWindowClosed: boolean;
  closureTrigger: RewardClosureTrigger;
  firstReservationAt: string | null;
  fundedAmountLuna: bigint;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  refundableExcessLuna: bigint;
  paidAmountLuna: bigint;
  feeSpentLuna: bigint;
  protectedFeeReserveLuna: bigint;
}

export interface RewardClosurePayoutAttempt {
  status: RewardPayoutAttemptState;
  transactionHash?: string | null;
  broadcastStartedAt?: string | null;
  broadcastAt?: string | null;
  chainStatus?: "confirmed" | "not_final" | "unknown" | null;
  manualReviewRequired?: boolean;
}

export interface RewardClosureReceipt {
  status: RewardReceiptState;
  amountLuna: bigint;
  payoutAttempts: ReadonlyArray<RewardClosurePayoutAttempt>;
}

export interface RewardClosureInput {
  campaign: RewardClosureCampaign;
  receipts: ReadonlyArray<RewardClosureReceipt>;
  vaultBalanceLuna: bigint;
}

export type RewardObligationReasonCode =
  | "none"
  | "unresolved_reward_obligations"
  | "payout_reconciliation_required"
  | "invalid_reward_accounting";

export interface RewardObligationSummary {
  unresolvedReceiptCount: number;
  unresolvedAmountLuna: bigint;
  reconciliationRequiredReceiptCount: number;
  reconciliationRequiredAmountLuna: bigint;
  invalidReceiptAmountCount: number;
  reasonCode: RewardObligationReasonCode;
}

export interface RewardRefundAccounting {
  fundedAmountLuna: bigint;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  paidAmountLuna: bigint;
  feeSpentLuna: bigint;
  protectedFeeReserveLuna: bigint;
  refundableExcessLuna: bigint;
  unusedRewardPrincipalLuna: bigint;
  unusedFeeReserveLuna: bigint;
  ledgerRefundableAmountLuna: bigint;
  vaultBalanceLuna: bigint;
  refundableAmountLuna: bigint;
}

export type RewardRefundCalculation =
  | {
      kind: "calculated";
      reasonCode: "calculated";
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
      unusedRewardPrincipalLuna: bigint;
      unusedFeeReserveLuna: bigint;
      refundableExcessLuna: bigint;
      ledgerRefundableAmountLuna: bigint;
    }
  | {
      kind: "invalid";
      reasonCode: "invalid_reward_accounting";
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
      unusedRewardPrincipalLuna: bigint;
      unusedFeeReserveLuna: bigint;
      refundableExcessLuna: bigint;
      ledgerRefundableAmountLuna: bigint;
    };

export type RewardClosureReasonCode =
  | "closable"
  | "unresolved_reward_obligations"
  | "payout_reconciliation_required"
  | "campaign_not_closable"
  | "already_refunded_or_closed"
  | "no_refundable_balance"
  | "invalid_reward_accounting";

export type RewardClosureResult =
  | {
      kind: "closable";
      reasonCode: "closable";
      obligations: RewardObligationSummary;
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
    }
  | {
      kind: "blocked";
      reasonCode:
        | "unresolved_reward_obligations"
        | "payout_reconciliation_required"
        | "campaign_not_closable"
        | "invalid_reward_accounting";
      obligations: RewardObligationSummary;
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
    }
  | {
      kind: "already_closed";
      reasonCode: "already_refunded_or_closed";
      obligations: RewardObligationSummary;
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
    }
  | {
      kind: "nothing_to_refund";
      reasonCode: "no_refundable_balance";
      obligations: RewardObligationSummary;
      accounting: RewardRefundAccounting;
      refundableAmountLuna: bigint;
    };

function isNonNegativeLuna(value: bigint): boolean {
  return typeof value === "bigint" && value >= ZERO_LUNA;
}

function isUnresolvedReceipt(status: RewardReceiptState): boolean {
  return status === "reserved" || status === "payout_pending" || status === "retryable";
}

function hasReconciliationEvidence(
  attempt: RewardClosurePayoutAttempt,
): boolean {
  return (
    (typeof attempt.transactionHash === "string" && attempt.transactionHash.trim() !== "") ||
    attempt.broadcastStartedAt !== null && attempt.broadcastStartedAt !== undefined ||
    attempt.broadcastAt !== null && attempt.broadcastAt !== undefined ||
    attempt.chainStatus === "unknown" ||
    attempt.chainStatus === "not_final" ||
    attempt.status === "confirmed" ||
    attempt.manualReviewRequired === true
  );
}

/** Summarize obligations without inspecting poll option or selection data. */
export function classifyRewardObligations(
  receipts: ReadonlyArray<RewardClosureReceipt>,
): RewardObligationSummary {
  let unresolvedReceiptCount = 0;
  let unresolvedAmountLuna = ZERO_LUNA;
  let reconciliationRequiredReceiptCount = 0;
  let reconciliationRequiredAmountLuna = ZERO_LUNA;
  let invalidReceiptAmountCount = 0;

  for (const receipt of receipts) {
    const unresolved = isUnresolvedReceipt(receipt.status);
    const amountIsValid = isNonNegativeLuna(receipt.amountLuna);
    if (receipt.status !== "paid" && !amountIsValid) {
      invalidReceiptAmountCount += 1;
    }

    if (unresolved) {
      unresolvedReceiptCount += 1;
    }
    if (unresolved && amountIsValid) {
      unresolvedAmountLuna += receipt.amountLuna;
    }

    if (receipt.status !== "paid" && receipt.payoutAttempts.some(hasReconciliationEvidence)) {
      reconciliationRequiredReceiptCount += 1;
      if (amountIsValid) {
        reconciliationRequiredAmountLuna += receipt.amountLuna;
      }
    }
  }

  const reasonCode: RewardObligationReasonCode =
    invalidReceiptAmountCount > 0
      ? "invalid_reward_accounting"
      : reconciliationRequiredReceiptCount > 0
        ? "payout_reconciliation_required"
        : unresolvedReceiptCount > 0
          ? "unresolved_reward_obligations"
          : "none";

  return {
    unresolvedReceiptCount,
    unresolvedAmountLuna,
    reconciliationRequiredReceiptCount,
    reconciliationRequiredAmountLuna,
    invalidReceiptAmountCount,
    reasonCode,
  };
}

function emptyAccounting(
  campaign: RewardClosureCampaign,
  vaultBalanceLuna: bigint,
): RewardRefundAccounting {
  return {
    fundedAmountLuna: campaign.fundedAmountLuna,
    rewardPrincipalLuna: campaign.rewardPrincipalLuna,
    feeReserveLuna: campaign.feeReserveLuna,
    paidAmountLuna: campaign.paidAmountLuna,
    feeSpentLuna: campaign.feeSpentLuna,
    protectedFeeReserveLuna: campaign.protectedFeeReserveLuna,
    refundableExcessLuna: campaign.refundableExcessLuna,
    unusedRewardPrincipalLuna: ZERO_LUNA,
    unusedFeeReserveLuna: ZERO_LUNA,
    ledgerRefundableAmountLuna: ZERO_LUNA,
    vaultBalanceLuna,
    refundableAmountLuna: ZERO_LUNA,
  };
}

function invalidCalculation(
  campaign: RewardClosureCampaign,
  vaultBalanceLuna: bigint,
): RewardRefundCalculation {
  const accounting = emptyAccounting(campaign, vaultBalanceLuna);
  return {
    kind: "invalid",
    reasonCode: "invalid_reward_accounting",
    accounting,
    refundableAmountLuna: ZERO_LUNA,
    unusedRewardPrincipalLuna: ZERO_LUNA,
    unusedFeeReserveLuna: ZERO_LUNA,
    refundableExcessLuna: ZERO_LUNA,
    ledgerRefundableAmountLuna: ZERO_LUNA,
  };
}

/**
 * Compute the exact refundable ledger remainder and cap it at the observed
 * vault balance. This function has no persistence, signing, or chain effects.
 */
export function calculateRefundableRewardAmount(
  campaign: RewardClosureCampaign,
  vaultBalanceLuna: bigint,
): RewardRefundCalculation {
  const campaignAmounts = [
    campaign.fundedAmountLuna,
    campaign.rewardPrincipalLuna,
    campaign.feeReserveLuna,
    campaign.refundableExcessLuna,
    campaign.paidAmountLuna,
    campaign.feeSpentLuna,
    campaign.protectedFeeReserveLuna,
    vaultBalanceLuna,
  ];

  if (
    campaignAmounts.some((amount) => !isNonNegativeLuna(amount)) ||
    campaign.paidAmountLuna > campaign.rewardPrincipalLuna ||
    campaign.feeSpentLuna > campaign.feeReserveLuna ||
    campaign.protectedFeeReserveLuna > campaign.feeReserveLuna - campaign.feeSpentLuna ||
    campaign.fundedAmountLuna !==
      campaign.rewardPrincipalLuna +
        campaign.feeReserveLuna +
        campaign.refundableExcessLuna
  ) {
    return invalidCalculation(campaign, vaultBalanceLuna);
  }

  const unusedRewardPrincipalLuna =
    campaign.rewardPrincipalLuna - campaign.paidAmountLuna;
  const unusedFeeReserveLuna =
    campaign.feeReserveLuna -
    campaign.feeSpentLuna -
    campaign.protectedFeeReserveLuna;
  const ledgerRefundableAmountLuna =
    unusedRewardPrincipalLuna +
    unusedFeeReserveLuna +
    campaign.refundableExcessLuna;
  const refundableAmountLuna =
    ledgerRefundableAmountLuna < vaultBalanceLuna
      ? ledgerRefundableAmountLuna
      : vaultBalanceLuna;
  const accounting: RewardRefundAccounting = {
    fundedAmountLuna: campaign.fundedAmountLuna,
    rewardPrincipalLuna: campaign.rewardPrincipalLuna,
    feeReserveLuna: campaign.feeReserveLuna,
    paidAmountLuna: campaign.paidAmountLuna,
    feeSpentLuna: campaign.feeSpentLuna,
    protectedFeeReserveLuna: campaign.protectedFeeReserveLuna,
    refundableExcessLuna: campaign.refundableExcessLuna,
    unusedRewardPrincipalLuna,
    unusedFeeReserveLuna,
    ledgerRefundableAmountLuna,
    vaultBalanceLuna,
    refundableAmountLuna,
  };

  return {
    kind: "calculated",
    reasonCode: "calculated",
    accounting,
    refundableAmountLuna,
    unusedRewardPrincipalLuna,
    unusedFeeReserveLuna,
    refundableExcessLuna: campaign.refundableExcessLuna,
    ledgerRefundableAmountLuna,
  };
}

function isCampaignClosable(campaign: RewardClosureCampaign): boolean {
  if (campaign.status === "cancelled") {
    return campaign.closureTrigger === "cancelled" && campaign.firstReservationAt === null;
  }

  return (
    (campaign.status === "funded" ||
      campaign.status === "rewarding" ||
      campaign.status === "exhausted") &&
    campaign.participationWindowClosed &&
    (campaign.closureTrigger === "poll_closed" || campaign.closureTrigger === "expired")
  );
}

function blockedResult(
  reasonCode:
    | "unresolved_reward_obligations"
    | "payout_reconciliation_required"
    | "campaign_not_closable"
    | "invalid_reward_accounting",
  obligations: RewardObligationSummary,
  campaign: RewardClosureCampaign,
  vaultBalanceLuna: bigint,
): RewardClosureResult {
  return {
    kind: "blocked",
    reasonCode,
    obligations,
    accounting: emptyAccounting(campaign, vaultBalanceLuna),
    refundableAmountLuna: ZERO_LUNA,
  };
}

/** Evaluate whether a campaign may close and expose its exact refund amount. */
export function evaluateRewardClosure(
  input: RewardClosureInput,
): RewardClosureResult {
  const obligations = classifyRewardObligations(input.receipts);

  if (input.campaign.status === "closed" || input.campaign.status === "refunded") {
    return {
      kind: "already_closed",
      reasonCode: "already_refunded_or_closed",
      obligations,
      accounting: emptyAccounting(input.campaign, input.vaultBalanceLuna),
      refundableAmountLuna: ZERO_LUNA,
    };
  }

  if (!isCampaignClosable(input.campaign)) {
    return blockedResult(
      "campaign_not_closable",
      obligations,
      input.campaign,
      input.vaultBalanceLuna,
    );
  }

  if (obligations.reasonCode !== "none") {
    return blockedResult(
      obligations.reasonCode,
      obligations,
      input.campaign,
      input.vaultBalanceLuna,
    );
  }

  const calculation = calculateRefundableRewardAmount(
    input.campaign,
    input.vaultBalanceLuna,
  );
  if (calculation.kind === "invalid") {
    return blockedResult(
      "invalid_reward_accounting",
      obligations,
      input.campaign,
      input.vaultBalanceLuna,
    );
  }

  if (calculation.refundableAmountLuna === ZERO_LUNA) {
    return {
      kind: "nothing_to_refund",
      reasonCode: "no_refundable_balance",
      obligations,
      accounting: calculation.accounting,
      refundableAmountLuna: ZERO_LUNA,
    };
  }

  return {
    kind: "closable",
    reasonCode: "closable",
    obligations,
    accounting: calculation.accounting,
    refundableAmountLuna: calculation.refundableAmountLuna,
  };
}
