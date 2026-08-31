import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import type { PublicRewardCampaign } from "@/types/rewards";

export type PollStatus = "draft" | "live" | "closed" | "cancelled";

export type ContributionMode = "creator" | "community";

export type VoteStatus =
  | "idle"
  | "option_selected"
  | "wallet_required"
  | "awaiting_confirmation"
  | "verifying"
  | "verified"
  | "cancelled"
  | "failed"
  | "already_voted"
  | "poll_closed";

export interface PollOptionView {
  id: string;
  label: string;
  walletCount?: number;
  /** Historical participant support only; never vote weight. */
  nimSignalled?: number;
  percentage?: number;
  isLeading?: boolean;
}

export interface PollResultView {
  options: PollOptionView[];
  totalWallets?: number;
  /** Historical participant support only; absent for reward-first polls. */
  totalNim?: number;
  leadingOptionId?: string;
  isFinal: boolean;
}

interface PollBase {
  id: string;
  question: string;
  context?: string;
  fairnessMode: string;
  category: PollCategory;
  format: PollFormat;
  createdAt: string;
  closingAt: string;
  status: PollStatus;
  options: PollOptionView[];
  hasVoted?: boolean;
  selectedOptionId?: string;
  results?: PollResultView;
}

export interface LegacySupportPollView extends PollBase {
  economicModel: "legacy_support";
  rewardMode: null;
  contributionMode: ContributionMode;
  destinationWallet: string;
  destinationPurpose: string;
  minimumNim: number;
}

export interface RewardFirstPollView extends PollBase {
  economicModel: "reward_first";
  rewardMode: "free" | "rewarded";
  contributionMode?: never;
  destinationWallet?: never;
  destinationPurpose?: never;
  minimumNim?: never;
  rewardCampaign?: PublicRewardCampaign;
}

export type PollView = LegacySupportPollView | RewardFirstPollView;

export interface VoteUiState {
  status: VoteStatus;
  selectedOptionId?: string;
  nimContribution?: number;
  recordedAt?: string;
  transactionRef?: string;
}

interface ReceiptBase {
  id: string;
  pollId: string;
  pollQuestion: string;
  chosenOption: string;
  recordedAt: string;
  pollUrl?: string;
}

/** Receipt fields that only exist for historical participant-support polls. */
export interface LegacySupportReceiptView extends ReceiptBase {
  economicModel: "legacy_support";
  nimContribution: number;
  transactionRef: string;
  explorerUrl?: string;
}

/** A reward-first receipt proves a verified vote, not a participant payment. */
export interface RewardFirstReceiptView extends ReceiptBase {
  economicModel: "reward_first";
  rewardMode: "free" | "rewarded";
  nimContribution?: never;
  transactionRef?: never;
  explorerUrl?: never;
}

export type ReceiptView = LegacySupportReceiptView | RewardFirstReceiptView;

export interface CreatorPollSummary {
  id: string;
  question: string;
  status: PollStatus;
  category: PollCategory;
  format: PollFormat;
  createdAt: string;
  closingAt?: string;
  totalWallets?: number;
  totalNim?: number;
  publicUrl?: string;
}

export type CreatorPollDetail = PollView & {
  publicUrl?: string;
};
