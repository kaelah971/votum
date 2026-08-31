import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import {
  POLL_ECONOMIC_MODEL,
  type PollEconomicModel,
  type RewardFirstMode,
  type RewardFundingMode,
} from "@/lib/polls/economic-model";

export {
  POLL_ECONOMIC_MODEL,
  type PollEconomicModel,
  type RewardFirstMode,
  type RewardFundingMode,
} from "@/lib/polls/economic-model";

export type DraftStatus =
  | "editing"
  | "awaiting_wallet"
  | "awaiting_verification"
  | "ready_to_publish";

export type LegacyDraftStep = "decision" | "support" | "review";
export type RewardFirstDraftStep = "decision" | "rewards" | "review";
export type DraftStep = LegacyDraftStep | "rewards";

interface DraftBase {
  id: string;
  question: string;
  context: string;
  options: string[];
  duration: string;
  category: PollCategory;
  format: PollFormat;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  /** Unique key used for idempotent poll publication. Set once, used once. */
  publicationIdempotencyKey?: string;
}

export interface LegacyRewardDraft {
  enabled: boolean;
  rewardPerParticipant?: string;
  maxRewardedParticipants?: string;
}

/** The persisted shape used by historical participant-support drafts. */
export interface LegacySupportDraft extends DraftBase {
  economicModel: "legacy_support";
  rewardMode: null;
  contributionMode: "creator" | "community" | null;
  destinationWallet: string;
  purpose: string;
  minimumNim: string;
  currentStep: LegacyDraftStep;
  /** Kept readable for old drafts that used the optional reward fields. */
  reward?: LegacyRewardDraft;
}

/** The persisted shape used by all newly-created drafts. */
export interface RewardFirstDraft extends DraftBase {
  economicModel: "reward_first";
  rewardMode: RewardFirstMode;
  rewardFundingMode?: RewardFundingMode;
  fundingWallet?: string;
  rewardPerParticipant?: string;
  maxRewardedParticipants?: string;
  currentStep: RewardFirstDraftStep;
  // A reward-first draft must never grow participant-support placeholders.
  contributionMode?: never;
  destinationWallet?: never;
  purpose?: never;
  minimumNim?: never;
  reward?: never;
}

/**
 * Storage's update helper performs a shallow merge and cannot preserve a
 * discriminated union while it is merging an arbitrary partial object. Keep
 * this storage-facing shape permissive, while the normalized/opened shapes
 * above remain strict and discriminated.
 */
export interface PollDraft extends DraftBase {
  economicModel: PollEconomicModel;
  rewardMode: RewardFirstMode | null;
  currentStep: DraftStep;
  contributionMode?: "creator" | "community" | null;
  destinationWallet?: string;
  purpose?: string;
  minimumNim?: string;
  rewardFundingMode?: RewardFundingMode;
  fundingWallet?: string;
  rewardPerParticipant?: string;
  maxRewardedParticipants?: string;
  reward?: LegacyRewardDraft;
}

export type NormalizedPollDraft = LegacySupportDraft | RewardFirstDraft;

/** Common fields passed from the Create form to the draft persistence hook. */
interface DraftFormBase {
  category: PollCategory;
  format: PollFormat;
  question: string;
  context: string;
  options: string[];
  duration: string;
}

export interface LegacyDraftFormData extends DraftFormBase {
  economicModel: "legacy_support";
  rewardMode: null;
  contributionMode: "creator" | "community" | null;
  purpose: string;
  destinationWallet: string;
  minimumNim: string;
  rewardEnabled: boolean;
  rewardPerParticipant: string;
  maxRewardedParticipants: string;
}

export interface RewardFirstDraftFormData extends DraftFormBase {
  economicModel: "reward_first";
  rewardMode: RewardFirstMode;
  rewardFundingMode?: RewardFundingMode;
  fundingWallet?: string;
  rewardPerParticipant?: string;
  maxRewardedParticipants?: string;
}

export type DraftFormData = LegacyDraftFormData | RewardFirstDraftFormData;

/**
 * Old local-storage entries predate the economic discriminator. They are
 * intentionally classified as legacy instead of being silently converted to
 * free polls. The storage key remains unchanged; normalization happens at
 * the boundary where a draft is opened.
 */
export function normalizePollDraft(input: unknown): NormalizedPollDraft | null {
  if (!isRecord(input) || typeof input.id !== "string") return null;

  if (
    input.economicModel !== undefined &&
    input.economicModel !== POLL_ECONOMIC_MODEL.LEGACY_SUPPORT_ENABLED &&
    input.economicModel !== POLL_ECONOMIC_MODEL.NEW_REWARD_FIRST_POLL
  ) {
    return null;
  }

  if (input.economicModel === POLL_ECONOMIC_MODEL.NEW_REWARD_FIRST_POLL) {
    const hasRewardSettings =
      hasValue(input.rewardFundingMode) ||
      hasValue(input.fundingWallet) ||
      hasValue(input.rewardPerParticipant) ||
      hasValue(input.maxRewardedParticipants) ||
      (isRecord(input.reward) && input.reward.enabled === true);
    const rewardMode: RewardFirstMode =
      input.rewardMode === "free" || input.rewardMode === "rewarded"
        ? input.rewardMode
        : hasRewardSettings
          ? "rewarded"
          : "free";

    const normalized: Record<string, unknown> = { ...input };
    // Never carry support-shaped keys into the normalized reward-first draft.
    delete normalized.contributionMode;
    delete normalized.destinationWallet;
    delete normalized.purpose;
    delete normalized.minimumNim;
    delete normalized.reward;

    normalized.economicModel = POLL_ECONOMIC_MODEL.NEW_REWARD_FIRST_POLL;
    normalized.rewardMode = rewardMode;
    normalized.currentStep =
      input.currentStep === "support" ? "rewards" : input.currentStep;
    return normalized as unknown as RewardFirstDraft;
  }

  // Missing or legacy discriminators always stay on the compatibility path.
  const normalized: Record<string, unknown> = { ...input };
  normalized.economicModel = POLL_ECONOMIC_MODEL.LEGACY_SUPPORT_ENABLED;
  normalized.rewardMode = null;
  normalized.currentStep =
    input.currentStep === "rewards" ? "support" : input.currentStep;
  normalized.contributionMode =
    input.contributionMode === "creator" || input.contributionMode === "community"
      ? input.contributionMode
      : null;
  normalized.destinationWallet =
    typeof input.destinationWallet === "string" ? input.destinationWallet : "";
  normalized.purpose = typeof input.purpose === "string" ? input.purpose : "";
  normalized.minimumNim =
    typeof input.minimumNim === "string" ? input.minimumNim : "";
  return normalized as unknown as LegacySupportDraft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value === "string" ? value.trim().length > 0 : true;
}
