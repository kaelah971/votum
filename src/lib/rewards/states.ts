/**
 * Reward-domain state vocabulary (V2B.2) — the exact states locked by the
 * design spec and implementation plan. These are the ONLY allowed state
 * values; DB CHECK constraints use the same literal sets.
 */

/** Campaign lifecycle state (design spec §0.1 / §4). */
export const REWARD_CAMPAIGN_STATES = [
  "configured",
  "funding_pending",
  "funded",
  "rewarding",
  "exhausted",
  "closed",
  "refunding",
  "refunded",
  "cancelled",
] as const;

export type RewardCampaignState = (typeof REWARD_CAMPAIGN_STATES)[number];

/** Campaign funding-transaction state (§16.2). */
export const REWARD_FUNDING_STATES = [
  "submitted",
  "confirmed",
  "rejected",
] as const;

export type RewardFundingState = (typeof REWARD_FUNDING_STATES)[number];

/** Per-wallet reward receipt lifecycle (§9 / §16.3). */
export const REWARD_RECEIPT_STATES = [
  "eligible",
  "reserved",
  "payout_pending",
  "paid",
  "failed",
  "retryable",
] as const;

export type RewardReceiptState = (typeof REWARD_RECEIPT_STATES)[number];

/** Payout attempt state (§16.4). */
export const REWARD_PAYOUT_ATTEMPT_STATES = [
  "pending",
  "confirmed",
  "failed",
  "retryable",
] as const;

export type RewardPayoutAttemptState = (typeof REWARD_PAYOUT_ATTEMPT_STATES)[number];

/** Refund state (§16.5). */
export const REWARD_REFUND_STATES = [
  "pending",
  "confirmed",
  "failed",
  "retryable",
] as const;

export type RewardRefundState = (typeof REWARD_REFUND_STATES)[number];

/** Campaign states in which a poll may be advertised as rewarded. */
export const REWARD_CAMPAIGN_ADVERTISED_STATES: ReadonlyArray<RewardCampaignState> = [
  "funded",
  "rewarding",
];

/** Receipt states that count toward "confirmed paid" (profile NIM earned). */
export const REWARD_RECEIPT_PAID_STATES: ReadonlyArray<RewardReceiptState> = [
  "paid",
];

/** Receipt states that still hold campaign principal (block refunds). */
export const REWARD_RECEIPT_UNRESOLVED_STATES: ReadonlyArray<RewardReceiptState> = [
  "reserved",
  "payout_pending",
  "retryable",
];

export function isRewardCampaignState(value: string): value is RewardCampaignState {
  return (REWARD_CAMPAIGN_STATES as readonly string[]).includes(value);
}

export function isRewardFundingState(value: string): value is RewardFundingState {
  return (REWARD_FUNDING_STATES as readonly string[]).includes(value);
}

export function isRewardReceiptState(value: string): value is RewardReceiptState {
  return (REWARD_RECEIPT_STATES as readonly string[]).includes(value);
}

export function isRewardPayoutAttemptState(value: string): value is RewardPayoutAttemptState {
  return (REWARD_PAYOUT_ATTEMPT_STATES as readonly string[]).includes(value);
}

export function isRewardRefundState(value: string): value is RewardRefundState {
  return (REWARD_REFUND_STATES as readonly string[]).includes(value);
}
