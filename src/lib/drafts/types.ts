import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";

export type DraftStatus =
  | "editing"
  | "awaiting_wallet"
  | "awaiting_verification"
  | "ready_to_publish";

export type DraftStep = "decision" | "support" | "review";

export interface PollDraft {
  id: string;
  question: string;
  context: string;
  options: string[];
  contributionMode: "creator" | "community" | null;
  destinationWallet: string;
  purpose: string;
  minimumNim: string;
  duration: string;
  category: PollCategory;
  format: PollFormat;
  currentStep: DraftStep;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  /** Unique key used for idempotent poll publication. Set once, used once. */
  publicationIdempotencyKey?: string;
  /** Optional rewarded-participation configuration (V2B.2.3). */
  reward?: {
    enabled: boolean;
    rewardPerParticipant?: string;
    maxRewardedParticipants?: string;
  };
}
