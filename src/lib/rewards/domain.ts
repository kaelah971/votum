import {
  MIN_REWARD_PER_PARTICIPANT_LUNA,
  computeFeeReserveLuna,
  computeRewardPrincipalLuna,
  computeTotalBudgetLuna,
} from "@/lib/rewards/constants";
import { PG_BIGINT_MAX } from "@/lib/nimiq/units";

/**
 * Reward-domain validation helpers (V2B.2).
 *
 * Strongly constrained reward-configuration types and pure validation.
 * All financial values are integer Luna (bigint) — never floating point.
 * The "fee reserve never counts as reward principal" invariant is enforced
 * structurally: `computeRewardPrincipalLuna` uses only the per-participant
 * reward and the participant cap.
 */

export interface RewardConfigInput {
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  feeReserveLuna: bigint;
}

export interface RewardConfigValidated {
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
}

export interface RewardConfigResult {
  ok: boolean;
  value?: RewardConfigValidated;
  errors: string[];
}

/** True when the value is a non-negative bigint (never a JS Number/float). */
export function isNonNegativeLuna(value: bigint): boolean {
  return typeof value === "bigint" && value >= BigInt(0);
}

/** True when the value is a positive bigint. */
export function isPositiveLuna(value: bigint): boolean {
  return typeof value === "bigint" && value > BigInt(0);
}

/** True when the value fits Postgres bigint (max safe stored value). */
export function fitsPgBigint(value: bigint): boolean {
  return typeof value === "bigint" && value <= PG_BIGINT_MAX;
}

/** True when the value fits a JS safe integer (Nimiq Pay SDK takes Number Luna). */
export function fitsSafeJsNumber(value: bigint): boolean {
  return typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * Validate a reward configuration.
 *
 * Enforces:
 * - reward per participant is integer Luna ≥ MIN_REWARD_PER_PARTICIPANT_LUNA
 * - max participants is a positive safe integer
 * - reward principal = perParticipant × max (integer arithmetic)
 * - fee reserve is non-negative, integer Luna
 * - total budget = principal + fee reserve, fits Postgres bigint
 *
 * The fee reserve is never added into the reward principal (D9).
 */
export function validateRewardConfig(
  input: RewardConfigInput,
): RewardConfigResult {
  const errors: string[] = [];

  if (!isPositiveLuna(input.rewardPerParticipantLuna)) {
    errors.push("rewardPerParticipantLuna must be a positive integer (bigint) Luna value");
  } else if (input.rewardPerParticipantLuna < MIN_REWARD_PER_PARTICIPANT_LUNA) {
    errors.push(
      `rewardPerParticipantLuna must be at least ${MIN_REWARD_PER_PARTICIPANT_LUNA} Luna (0.01 NIM)`,
    );
  }

  if (
    !Number.isSafeInteger(input.maxRewardedParticipants) ||
    input.maxRewardedParticipants <= 0
  ) {
    errors.push("maxRewardedParticipants must be a positive safe integer");
  }

  if (!isNonNegativeLuna(input.feeReserveLuna)) {
    errors.push("feeReserveLuna must be a non-negative integer (bigint) Luna value");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const rewardPrincipalLuna = computeRewardPrincipalLuna(
    input.rewardPerParticipantLuna,
    input.maxRewardedParticipants,
  );
  const totalBudgetLuna = computeTotalBudgetLuna(
    rewardPrincipalLuna,
    input.feeReserveLuna,
  );

  if (!fitsPgBigint(rewardPrincipalLuna)) {
    errors.push("rewardPrincipalLuna exceeds Postgres bigint range");
  }
  if (!fitsPgBigint(totalBudgetLuna)) {
    errors.push("totalBudgetLuna exceeds Postgres bigint range");
  }
  if (!fitsSafeJsNumber(totalBudgetLuna)) {
    errors.push("totalBudgetLuna exceeds the Nimiq Pay safe integer range");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      rewardPerParticipantLuna: input.rewardPerParticipantLuna,
      maxRewardedParticipants: input.maxRewardedParticipants,
      rewardPrincipalLuna,
      feeReserveLuna: input.feeReserveLuna,
      totalBudgetLuna,
    },
    errors,
  };
}

/** Validate a config whose fee reserve is computed via the MVP formula. */
export function validateRewardConfigWithDefaultFee(
  rewardPerParticipantLuna: bigint,
  maxRewardedParticipants: number,
): RewardConfigResult {
  return validateRewardConfig({
    rewardPerParticipantLuna,
    maxRewardedParticipants,
    feeReserveLuna: computeFeeReserveLuna(maxRewardedParticipants),
  });
}
