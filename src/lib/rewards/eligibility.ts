import { canonicalWalletKey } from "@/lib/format";
import { MIN_REWARD_PER_PARTICIPANT_LUNA } from "@/lib/rewards/constants";
import type { RewardCampaignState, RewardReceiptState } from "@/lib/rewards/states";

export interface RewardPollForEligibility {
  id: string;
  economicModel: "legacy_support" | "reward_first";
  rewardMode: "free" | "rewarded" | null;
  isPublic: boolean;
  status: string;
  creatorWallet: string;
}

export interface RewardCampaignForEligibility {
  id: string;
  pollId: string;
  status: RewardCampaignState;
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardedParticipantCount: number;
  firstReservationAt: string | null;
  creatorWallet: string;
}

export interface RewardEligibilityInput {
  poll: RewardPollForEligibility;
  campaign: RewardCampaignForEligibility | null;
  participation: {
    id: string;
    pollId: string;
    participantWallet: string;
    committed: boolean;
    walletVerified: boolean;
    /** Existing poll-vote shape may carry the option; eligibility ignores it. */
    selectedOptionId?: string;
  };
  existingReceipt: RewardReceiptForEligibility | null;
  /** Untrusted compatibility input; never used as financial truth. */
  clientRewardAmountLuna?: unknown;
}

export interface RewardReceiptForEligibility {
  id: string;
  campaignId: string;
  participantWallet: string;
  amountLuna: bigint;
  status: RewardReceiptState;
}

export type RewardEligibilityReasonCode =
  | "eligible"
  | "creator_not_reward_eligible"
  | "already_rewarded_or_reserved"
  | "campaign_not_funded"
  | "campaign_not_reservable"
  | "no_reward_capacity"
  | "poll_not_public"
  | "poll_not_rewarded"
  | "invalid_participation";

export type RewardEligibilityResult =
  | {
      status: "eligible";
      reasonCode: "eligible";
      campaignId: string;
      participationId: string;
      participantWallet: string;
      rewardAmountLuna: bigint;
      reservationStatus: "reserved";
      remainingCapacity: number;
      shouldSetFirstReservationAt: boolean;
      nextCampaignState: "rewarding" | "exhausted";
    }
  | {
      status: "already_reserved";
      reasonCode: "already_rewarded_or_reserved";
      campaignId: string;
      receiptId: string;
      rewardAmountLuna: bigint;
    }
  | {
      status: "no_capacity";
      reasonCode: "no_reward_capacity";
      campaignId: string;
    }
  | {
      status: "ineligible";
      reasonCode: Exclude<RewardEligibilityReasonCode, "eligible" | "already_rewarded_or_reserved" | "no_reward_capacity">;
      campaignId?: string;
    };

function sameWallet(left: string, right: string): boolean {
  return canonicalWalletKey(left) === canonicalWalletKey(right);
}

function isPublicPoll(poll: RewardPollForEligibility): boolean {
  return poll.isPublic && (poll.status === "live" || poll.status === "closed");
}

function isRewardedPoll(
  poll: RewardPollForEligibility,
  campaign: RewardCampaignForEligibility | null,
): boolean {
  if (poll.economicModel === "reward_first") return poll.rewardMode === "rewarded";
  return campaign !== null;
}

function hasValidParticipation(input: RewardEligibilityInput): boolean {
  const { participation, poll } = input;
  return participation.id.trim().length > 0 &&
    participation.pollId === poll.id &&
    participation.participantWallet.trim().length > 0 &&
    participation.committed &&
    participation.walletVerified;
}

function hasValidCampaignTerms(campaign: RewardCampaignForEligibility): boolean {
  return typeof campaign.rewardPerParticipantLuna === "bigint" &&
    campaign.rewardPerParticipantLuna >= MIN_REWARD_PER_PARTICIPANT_LUNA &&
    Number.isSafeInteger(campaign.maxRewardedParticipants) &&
    campaign.maxRewardedParticipants >= 0 &&
    Number.isSafeInteger(campaign.rewardedParticipantCount) &&
    campaign.rewardedParticipantCount >= 0 &&
    campaign.rewardedParticipantCount <= campaign.maxRewardedParticipants;
}

export function evaluateRewardEligibility(
  input: RewardEligibilityInput,
): RewardEligibilityResult {
  const { poll, campaign, participation } = input;

  if (!hasValidParticipation(input)) {
    return { status: "ineligible", reasonCode: "invalid_participation" };
  }
  if (!isPublicPoll(poll)) {
    return { status: "ineligible", reasonCode: "poll_not_public" };
  }
  if (!isRewardedPoll(poll, campaign)) {
    return { status: "ineligible", reasonCode: "poll_not_rewarded" };
  }
  if (!campaign) {
    return { status: "ineligible", reasonCode: "campaign_not_funded" };
  }
  if (campaign.pollId !== poll.id || !sameWallet(campaign.creatorWallet, poll.creatorWallet)) {
    return {
      status: "ineligible",
      reasonCode: "campaign_not_reservable",
      campaignId: campaign.id,
    };
  }
  if (campaign.status === "configured" || campaign.status === "funding_pending" || campaign.status === "cancelled") {
    return { status: "ineligible", reasonCode: "campaign_not_funded", campaignId: campaign.id };
  }
  if (campaign.status !== "funded" && campaign.status !== "rewarding" && campaign.status !== "exhausted") {
    return { status: "ineligible", reasonCode: "campaign_not_reservable", campaignId: campaign.id };
  }
  if (!hasValidCampaignTerms(campaign)) {
    return { status: "ineligible", reasonCode: "campaign_not_reservable", campaignId: campaign.id };
  }
  if (sameWallet(participation.participantWallet, poll.creatorWallet)) {
    return { status: "ineligible", reasonCode: "creator_not_reward_eligible", campaignId: campaign.id };
  }

  const existingReceipt = input.existingReceipt;
  if (existingReceipt) {
    return {
      status: "already_reserved",
      reasonCode: "already_rewarded_or_reserved",
      campaignId: campaign.id,
      receiptId: existingReceipt.id,
      rewardAmountLuna: existingReceipt.amountLuna,
    };
  }

  const remainingCapacity = campaign.maxRewardedParticipants - campaign.rewardedParticipantCount;
  if (remainingCapacity <= 0 || campaign.status === "exhausted") {
    return { status: "no_capacity", reasonCode: "no_reward_capacity", campaignId: campaign.id };
  }

  const nextCount = campaign.rewardedParticipantCount + 1;
  return {
    status: "eligible",
    reasonCode: "eligible",
    campaignId: campaign.id,
    participationId: participation.id,
    participantWallet: participation.participantWallet,
    rewardAmountLuna: campaign.rewardPerParticipantLuna,
    reservationStatus: "reserved",
    remainingCapacity,
    shouldSetFirstReservationAt: campaign.firstReservationAt === null,
    nextCampaignState: nextCount >= campaign.maxRewardedParticipants ? "exhausted" : "rewarding",
  };
}
