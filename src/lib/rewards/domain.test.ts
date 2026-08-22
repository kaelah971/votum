import { describe, it, expect } from "vitest";
import { LUNA_PER_NIM, PG_BIGINT_MAX } from "@/lib/nimiq/units";
import {
  MIN_REWARD_PER_PARTICIPANT_LUNA,
  ESTIMATED_TX_FEE_LUNA,
  FEE_RESERVE_SAFETY_MULTIPLIER,
  MAX_PAYOUT_ATTEMPTS,
  computeRewardPrincipalLuna,
  computeTotalBudgetLuna,
  computeFeeReserveLuna,
} from "@/lib/rewards/constants";
import {
  validateRewardConfig,
  validateRewardConfigWithDefaultFee,
  isNonNegativeLuna,
  isPositiveLuna,
  fitsPgBigint,
  fitsSafeJsNumber,
} from "@/lib/rewards/domain";
import {
  REWARD_CAMPAIGN_STATES,
  REWARD_FUNDING_STATES,
  REWARD_RECEIPT_STATES,
  REWARD_PAYOUT_ATTEMPT_STATES,
  REWARD_REFUND_STATES,
  REWARD_RECEIPT_PAID_STATES,
  REWARD_RECEIPT_UNRESOLVED_STATES,
  isRewardCampaignState,
  isRewardReceiptState,
} from "@/lib/rewards/states";

describe("reward constants", () => {
  it("reuses the existing LUNA_PER_NIM source of truth (1 NIM = 100,000 Luna)", () => {
    expect(LUNA_PER_NIM).toBe(BigInt(100000));
  });

  it("minimum reward is exactly 1,000 Luna (0.01 NIM)", () => {
    expect(MIN_REWARD_PER_PARTICIPANT_LUNA).toBe(BigInt(1000));
    expect(MIN_REWARD_PER_PARTICIPANT_LUNA * BigInt(100)).toBe(LUNA_PER_NIM);
  });

  it("exposes a centralized fee estimate constant (no scattered literals)", () => {
    expect(typeof ESTIMATED_TX_FEE_LUNA).toBe("bigint");
    expect(ESTIMATED_TX_FEE_LUNA > BigInt(0)).toBe(true);
    expect(Number.isInteger(Number(ESTIMATED_TX_FEE_LUNA))).toBe(true);
  });

  it("defines a payout-attempt bound", () => {
    expect(MAX_PAYOUT_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe("principal calculation", () => {
  it("computes principal with exact integer arithmetic", () => {
    // 0.5 NIM = 50,000 Luna × 200 participants
    expect(computeRewardPrincipalLuna(BigInt(50000), 200)).toBe(BigInt(10000000));
    expect(computeRewardPrincipalLuna(MIN_REWARD_PER_PARTICIPANT_LUNA, 1)).toBe(
      BigInt(1000),
    );
  });

  it("never includes the fee reserve in principal", () => {
    const principal = computeRewardPrincipalLuna(BigInt(50000), 200);
    const fee = computeFeeReserveLuna(200);
    expect(principal).toBe(BigInt(10000000));
    // total budget = principal + fee reserve (separate ledgers)
    expect(computeTotalBudgetLuna(principal, fee)).toBe(principal + fee);
  });
});

describe("fee reserve formula", () => {
  it("sizes reserve = estimatedFee × max × safety multiplier", () => {
    expect(computeFeeReserveLuna(10)).toBe(
      ESTIMATED_TX_FEE_LUNA * BigInt(10) * FEE_RESERVE_SAFETY_MULTIPLIER,
    );
    expect(computeFeeReserveLuna(10, BigInt(4000), BigInt(2))).toBe(BigInt(80000));
  });
});

describe("luna guard helpers", () => {
  it("rejects JS Number / negative values for money", () => {
    expect(isNonNegativeLuna(BigInt(0))).toBe(true);
    expect(isNonNegativeLuna(BigInt(-1))).toBe(false);
    expect(isPositiveLuna(BigInt(1))).toBe(true);
    expect(isPositiveLuna(BigInt(0))).toBe(false);
  });

  it("bounds values to Postgres bigint and safe JS number", () => {
    expect(fitsPgBigint(PG_BIGINT_MAX)).toBe(true);
    expect(fitsPgBigint(PG_BIGINT_MAX + BigInt(1))).toBe(false);
    expect(fitsSafeJsNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(fitsSafeJsNumber(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))).toBe(false);
  });
});

describe("validateRewardConfig", () => {
  it("accepts a valid configuration and returns exact integer amounts", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: BigInt(50000),
      maxRewardedParticipants: 200,
      feeReserveLuna: computeFeeReserveLuna(200),
    });
    expect(result.ok).toBe(true);
    expect(result.value?.rewardPrincipalLuna).toBe(BigInt(10000000));
    expect(result.value?.totalBudgetLuna).toBe(
      BigInt(10000000) + computeFeeReserveLuna(200),
    );
  });

  it("accepts exactly 0.01 NIM (1,000 Luna)", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: MIN_REWARD_PER_PARTICIPANT_LUNA,
      maxRewardedParticipants: 1,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects reward below the minimum", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: BigInt(999),
      maxRewardedParticipants: 1,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("0.01 NIM");
  });

  it("rejects zero max participants", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: BigInt(50000),
      maxRewardedParticipants: 0,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("positive safe integer");
  });

  it("rejects negative fee reserve", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: BigInt(50000),
      maxRewardedParticipants: 10,
      feeReserveLuna: BigInt(-1),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects float/JS Number values", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: 0.5 as unknown as bigint,
      maxRewardedParticipants: 10,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects overflow beyond Postgres bigint", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: PG_BIGINT_MAX,
      maxRewardedParticipants: 2,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("bigint range");
  });

  it("rejects totals above the Nimiq Pay safe-integer range", () => {
    const result = validateRewardConfig({
      rewardPerParticipantLuna: BigInt(50000),
      maxRewardedParticipants: Number.MAX_SAFE_INTEGER,
      feeReserveLuna: BigInt(0),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("safe integer");
  });

  it("validates with the default fee-reserve formula", () => {
    const result = validateRewardConfigWithDefaultFee(BigInt(50000), 200);
    expect(result.ok).toBe(true);
    expect(result.value?.feeReserveLuna).toBe(computeFeeReserveLuna(200));
  });
});

describe("state vocabulary", () => {
  it("campaign states match the locked design vocabulary", () => {
    expect(REWARD_CAMPAIGN_STATES).toEqual([
      "configured",
      "funding_pending",
      "funded",
      "rewarding",
      "exhausted",
      "closed",
      "refunding",
      "refunded",
      "cancelled",
    ]);
    expect(isRewardCampaignState("funded")).toBe(true);
    expect(isRewardCampaignState("bogus")).toBe(false);
  });

  it("funding/receipt/payout/refund states match the locked vocabulary", () => {
    expect(REWARD_FUNDING_STATES).toEqual(["submitted", "confirmed", "rejected"]);
    expect(REWARD_RECEIPT_STATES).toEqual([
      "eligible",
      "reserved",
      "payout_pending",
      "paid",
      "failed",
      "retryable",
    ]);
    expect(REWARD_PAYOUT_ATTEMPT_STATES).toEqual(["pending", "confirmed", "failed", "retryable"]);
    expect(REWARD_REFUND_STATES).toEqual(["pending", "confirmed", "failed", "retryable"]);
    expect(isRewardReceiptState("paid")).toBe(true);
    expect(isRewardReceiptState("nope")).toBe(false);
  });

  it("only paid receipts count toward NIM earned", () => {
    expect(REWARD_RECEIPT_PAID_STATES).toEqual(["paid"]);
  });

  it("unresolved states block refunds", () => {
    expect(REWARD_RECEIPT_UNRESOLVED_STATES).toEqual([
      "reserved",
      "payout_pending",
      "retryable",
    ]);
  });
});
