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
  nimSignalled?: number;
  percentage?: number;
  isLeading?: boolean;
}

export interface PollResultView {
  options: PollOptionView[];
  totalWallets?: number;
  totalNim?: number;
  leadingOptionId?: string;
  isFinal: boolean;
}

export interface PollView {
  id: string;
  question: string;
  context?: string;
  contributionMode: ContributionMode;
  destinationWallet: string;
  destinationPurpose: string;
  minimumNim: number;
  fairnessMode: string;
  createdAt: string;
  closingAt: string;
  status: PollStatus;
  options: PollOptionView[];
  hasVoted?: boolean;
  selectedOptionId?: string;
  results?: PollResultView;
}

export interface VoteUiState {
  status: VoteStatus;
  selectedOptionId?: string;
  nimContribution?: number;
  recordedAt?: string;
  transactionRef?: string;
}

export interface ReceiptView {
  id: string;
  pollId: string;
  pollQuestion: string;
  chosenOption: string;
  nimContribution: number;
  recordedAt: string;
  transactionRef: string;
  explorerUrl?: string;
  pollUrl?: string;
}

export interface CreatorPollSummary {
  id: string;
  question: string;
  status: PollStatus;
  createdAt: string;
  closingAt?: string;
  totalWallets?: number;
  totalNim?: number;
  publicUrl?: string;
}

export interface CreatorPollDetail extends PollView {
  publicUrl?: string;
}
