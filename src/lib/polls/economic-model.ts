export const POLL_ECONOMIC_MODEL = {
  LEGACY_SUPPORT_ENABLED: "legacy_support",
  NEW_REWARD_FIRST_POLL: "reward_first",
} as const;

export const LEGACY_SUPPORT_ENABLED =
  POLL_ECONOMIC_MODEL.LEGACY_SUPPORT_ENABLED;
export const NEW_REWARD_FIRST_POLL =
  POLL_ECONOMIC_MODEL.NEW_REWARD_FIRST_POLL;

export type PollEconomicModel =
  (typeof POLL_ECONOMIC_MODEL)[keyof typeof POLL_ECONOMIC_MODEL];
export type RewardFirstMode = "free" | "rewarded";
export type RewardFundingMode = "creator" | "community";

const REWARD_FIRST_MODES: readonly RewardFirstMode[] = ["free", "rewarded"];
const REWARD_FUNDING_MODES: readonly RewardFundingMode[] = [
  "creator",
  "community",
];

export function isPollEconomicModel(
  value: unknown,
): value is PollEconomicModel {
  return value === LEGACY_SUPPORT_ENABLED || value === NEW_REWARD_FIRST_POLL;
}

export function isRewardFirstMode(value: unknown): value is RewardFirstMode {
  return REWARD_FIRST_MODES.includes(value as RewardFirstMode);
}

export function isRewardFundingMode(
  value: unknown,
): value is RewardFundingMode {
  return REWARD_FUNDING_MODES.includes(value as RewardFundingMode);
}

export interface EconomicRewardInput {
  fundingMode?: unknown;
  fundingWallet?: unknown;
  rewardPerParticipant?: unknown;
  maxRewardedParticipants?: unknown;
}

export interface EconomicModelInput {
  economicModel?: unknown;
  rewardMode?: unknown;
  reward?: EconomicRewardInput | null;
  creatorWallet?: unknown;
  mode?: unknown;
  contributionMode?: unknown;
  destinationWallet?: unknown;
  destinationPurpose?: unknown;
  minimumNim?: unknown;
}

export type EconomicModelValidation =
  | {
      ok: true;
      economicModel: PollEconomicModel;
      rewardMode: RewardFirstMode | null;
      fundingMode?: RewardFundingMode;
      fundingWallet?: string;
    }
  | { ok: false; errors: string[] };

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function hasLegacySupportFields(input: EconomicModelInput): boolean {
  return [
    input.mode,
    input.contributionMode,
    input.destinationWallet,
    input.destinationPurpose,
    input.minimumNim,
  ].some(hasValue);
}

function hasCompleteLegacySupportFields(input: EconomicModelInput): boolean {
  return (
    typeof input.mode === "string" &&
    (input.mode === "creator" || input.mode === "community") &&
    typeof input.destinationWallet === "string" &&
    input.destinationWallet.trim().length > 0 &&
    typeof input.destinationPurpose === "string" &&
    input.destinationPurpose.trim().length > 0 &&
    typeof input.minimumNim === "string" &&
    input.minimumNim.trim().length > 0
  );
}

export function validateEconomicModelInput(
  input: EconomicModelInput,
): EconomicModelValidation {
  const errors: string[] = [];
  const economicModel = input.economicModel;

  if (!isPollEconomicModel(economicModel)) {
    errors.push("economicModel");
    return { ok: false, errors };
  }

  if (economicModel === LEGACY_SUPPORT_ENABLED) {
    if (input.rewardMode !== undefined && input.rewardMode !== null) {
      errors.push("rewardMode");
    }
    if (input.reward !== undefined && input.reward !== null) errors.push("reward");
    if (!hasCompleteLegacySupportFields(input)) {
      errors.push("legacySupportFields");
    }
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, economicModel, rewardMode: null };
  }

  if (!isRewardFirstMode(input.rewardMode)) {
    errors.push("rewardMode");
  }
  if (hasLegacySupportFields(input)) {
    errors.push("legacySupportFields");
  }

  if (input.rewardMode === "free") {
    if (input.reward !== undefined && input.reward !== null) errors.push("reward");
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, economicModel, rewardMode: "free" };
  }

  if (input.rewardMode === "rewarded") {
    const reward = input.reward;
    if (!reward || !isRewardFundingMode(reward.fundingMode)) {
      errors.push("fundingMode");
    } else {
      const fundingWallet =
        typeof reward.fundingWallet === "string"
          ? reward.fundingWallet.trim()
          : typeof input.creatorWallet === "string"
            ? input.creatorWallet.trim()
            : "";
      if (reward.fundingMode === "community" && !fundingWallet) {
        errors.push("fundingWallet");
      }
      if (reward.fundingMode === "creator" && reward.fundingWallet !== undefined) {
        const requestedWallet =
          typeof reward.fundingWallet === "string"
            ? reward.fundingWallet.trim()
            : "";
        if (
          typeof input.creatorWallet === "string" &&
          requestedWallet &&
          requestedWallet.toLowerCase() !== input.creatorWallet.trim().toLowerCase()
        ) {
          errors.push("fundingWallet");
        }
      }
      if (errors.length === 0) {
        return {
          ok: true,
          economicModel,
          rewardMode: "rewarded",
          fundingMode: reward.fundingMode,
          fundingWallet,
        };
      }
    }
  }

  return { ok: false, errors };
}
