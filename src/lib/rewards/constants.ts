import { LUNA_PER_NIM } from "@/lib/nimiq/units";

export { LUNA_PER_NIM };

/**
 * Centralized reward-domain constants (V2B.2).
 *
 * Single source of truth — no scattered numeric literals across the app.
 * All money values are integer Luna (1 NIM = 100_000 Luna).
 * ES2017 target: use the BigInt() constructor, never `1000n` literals.
 */

/** Minimum reward per participant (D6): 0.01 NIM = 1,000 Luna. */
export const MIN_REWARD_PER_PARTICIPANT_LUNA = BigInt(1000);

/**
 * MVP per-transaction network-fee estimate (D9).
 *
 * The repo exposes no dynamic on-chain fee/gas oracle, so the approved MVP
 * policy is a fixed, centrally-configured estimate used to size the fee
 * reserve and gate broadcasts. Actual fees are observed from the chain per
 * transaction and accounted via `fee_spent_luna`.
 *
 * Provisional value pending the V2B.2.3 fee-reserve sizing step; the constant
 * is the single location to adjust.
 */
export const ESTIMATED_TX_FEE_LUNA = BigInt(4000);

/**
 * Safety multiplier applied when sizing the fee reserve (feeReserve =
 * estimatedFee × maxParticipants × multiplier). Bounds the risk of the
 * reserve running dry mid-campaign; final policy is settled at V2B.2.3.
 */
export const FEE_RESERVE_SAFETY_MULTIPLIER = BigInt(2);

/** Maximum payout attempts per receipt before it is final-failed. */
export const MAX_PAYOUT_ATTEMPTS = 5;

/**
 * Required reward principal: per-participant reward × participant cap.
 * The fee reserve is NEVER counted as reward principal (D9).
 */
export function computeRewardPrincipalLuna(
  rewardPerParticipantLuna: bigint,
  maxRewardedParticipants: number,
): bigint {
  return rewardPerParticipantLuna * BigInt(maxRewardedParticipants);
}

/**
 * Total campaign budget the creator must fund:
 * reward principal + operational fee reserve (D9).
 */
export function computeTotalBudgetLuna(
  rewardPrincipalLuna: bigint,
  feeReserveLuna: bigint,
): bigint {
  return rewardPrincipalLuna + feeReserveLuna;
}

/**
 * MVP fee-reserve sizing formula:
 *   feeReserve = estimatedTxFee × maxParticipants × safetyMultiplier
 */
export function computeFeeReserveLuna(
  maxRewardedParticipants: number,
  estimatedTxFeeLuna: bigint = ESTIMATED_TX_FEE_LUNA,
  safetyMultiplier: bigint = FEE_RESERVE_SAFETY_MULTIPLIER,
): bigint {
  return estimatedTxFeeLuna * BigInt(maxRewardedParticipants) * safetyMultiplier;
}
