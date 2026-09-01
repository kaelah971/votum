export type RewardFundingDisplayState =
  | "configured"
  | "intent_pending"
  | "submitted"
  | "funded"
  | "terminal";

export interface RewardFundingSnapshot {
  status: string | null;
  submittedTransactionHash: unknown;
}

const FUNDED_CAMPAIGN_STATES = new Set(["funded", "rewarding", "exhausted"]);

export function isBoundRewardFundingHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

export function deriveRewardFundingDisplayState(
  campaignState: string,
  funding: RewardFundingSnapshot | null,
): RewardFundingDisplayState {
  if (FUNDED_CAMPAIGN_STATES.has(campaignState)) return "funded";
  if (isBoundRewardFundingHash(funding?.submittedTransactionHash)) return "submitted";
  if (campaignState === "funding_pending" && funding?.status === "submitted") {
    return "intent_pending";
  }
  if (campaignState === "configured") return "configured";
  return "terminal";
}
