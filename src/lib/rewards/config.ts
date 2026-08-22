import {
  MIN_REWARD_PER_PARTICIPANT_LUNA,
  computeFeeReserveLuna,
  computeRewardPrincipalLuna,
  computeTotalBudgetLuna,
} from "@/lib/rewards/constants";
import { nimDecimalToLuna } from "@/lib/nimiq/units";
import type { RewardCampaignState } from "@/lib/rewards/states";

/**
 * V2B.2.3 — creator reward configuration domain.
 *
 * Single source of truth for:
 *   - parsing/validating creator reward input (strict NIM decimal → Luna)
 *   - the approved MVP fee-reserve formula
 *   - derived economic terms (principal, fee reserve, total required funding)
 *   - configuration mutability / immutability guard (D10 boundary)
 *
 * All money is integer Luna. UI never computes financial totals independently;
 * it calls into this module.
 */

/** Domain ceiling for max rewarded participants (integer-safe, far below PG int). */
export const MAX_REWARDED_PARTICIPANTS = 100_000;

/**
 * Fee-reserve policy (D9) — the approved MVP sizing:
 *   feeReserve = ESTIMATED_TX_FEE_LUNA × maxParticipants × FEE_RESERVE_SAFETY_MULTIPLIER
 *
 * The estimate covers one payout broadcast per participant plus the
 * operational safety multiplier. Refund/funding operational allowance is
 * folded into the multiplier for MVP (no gas oracle; observed chain fees
 * reconcile later). Single pure source of truth — mirrors
 * `computeFeeReserveLuna` in constants.ts.
 */
export function computeCampaignFeeReserveLuna(maxRewardedParticipants: number): bigint {
  return computeFeeReserveLuna(maxRewardedParticipants);
}

export interface RewardConfigInput {
  /** Strict NIM decimal string, e.g. "0.5" (validated via nimDecimalToLuna). */
  rewardPerParticipant: string;
  /** Positive integer participant cap. */
  maxRewardedParticipants: number;
}

export interface ValidatedRewardConfig {
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
}

export interface RewardConfigResult {
  ok: boolean;
  value?: ValidatedRewardConfig;
  errors: string[];
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate creator reward configuration.
 *
 * - rewardPerParticipant: strict NIM decimal → Luna via nimDecimalToLuna
 *   (rejects signs, exponents, commas, unsafe precision, non-positive, > PG max)
 * - rewardPerParticipant ≥ MIN_REWARD_PER_PARTICIPANT_LUNA (0.01 NIM)
 * - maxRewardedParticipants: positive safe integer ≤ MAX_REWARDED_PARTICIPANTS
 * - derived arithmetic via bigint; fee reserve via the approved formula;
 *   principal and fee reserve stay separate (D9).
 */
export function validateRewardConfigInput(input: RewardConfigInput): RewardConfigResult {
  const errors: string[] = [];

  let perLuna: bigint | null = null;
  if (typeof input.rewardPerParticipant !== "string") {
    errors.push("rewardPerParticipant must be a decimal NIM string");
  } else {
    try {
      perLuna = nimDecimalToLuna(input.rewardPerParticipant);
    } catch {
      errors.push("rewardPerParticipant must be a valid positive NIM amount (max 5 decimals, no signs/exponents)");
    }
    if (perLuna !== null && perLuna < MIN_REWARD_PER_PARTICIPANT_LUNA) {
      errors.push("rewardPerParticipant must be at least 0.01 NIM");
    }
  }

  if (!isSafePositiveInt(input.maxRewardedParticipants)) {
    errors.push("maxRewardedParticipants must be a positive whole number");
  } else if (input.maxRewardedParticipants > MAX_REWARDED_PARTICIPANTS) {
    errors.push(`maxRewardedParticipants cannot exceed ${MAX_REWARDED_PARTICIPANTS}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const rewardPerParticipantLuna = perLuna as bigint;
  const maxRewardedParticipants = input.maxRewardedParticipants;
  const rewardPrincipalLuna = computeRewardPrincipalLuna(
    rewardPerParticipantLuna,
    maxRewardedParticipants,
  );
  const feeReserveLuna = computeCampaignFeeReserveLuna(maxRewardedParticipants);
  const totalBudgetLuna = computeTotalBudgetLuna(rewardPrincipalLuna, feeReserveLuna);

  return {
    ok: true,
    value: {
      rewardPerParticipantLuna,
      maxRewardedParticipants,
      rewardPrincipalLuna,
      feeReserveLuna,
      totalBudgetLuna,
    },
    errors,
  };
}

/**
 * Campaign states in which economic terms may still be mutated.
 * Per the plan: mutable only while `configured` (D10 boundary — once funding
 * begins or any reservation exists, terms are immutable).
 */
export const CONFIG_MUTABLE_STATES: ReadonlyArray<RewardCampaignState> = ["configured"];

/**
 * True when a campaign's economic terms may be edited.
 */
export function isConfigMutable(state: RewardCampaignState): boolean {
  return CONFIG_MUTABLE_STATES.includes(state);
}

/**
 * Fail-closed immutability guard. Throws when a campaign's terms are locked.
 */
export function assertConfigMutable(state: RewardCampaignState): void {
  if (!isConfigMutable(state)) {
    throw new Error(`reward terms are immutable in campaign state '${state}'`);
  }
}
