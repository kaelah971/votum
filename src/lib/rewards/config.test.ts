import { describe, it, expect } from "vitest";
import {
  MAX_REWARDED_PARTICIPANTS,
  computeCampaignFeeReserveLuna,
  validateRewardConfigInput,
  CONFIG_MUTABLE_STATES,
  isConfigMutable,
  assertConfigMutable,
} from "@/lib/rewards/config";
import { ESTIMATED_TX_FEE_LUNA, FEE_RESERVE_SAFETY_MULTIPLIER } from "@/lib/rewards/constants";

describe("reward config validation", () => {
  it("accepts exactly 0.01 NIM (1,000 Luna)", () => {
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.value?.rewardPerParticipantLuna).toBe(BigInt(1000));
  });

  it("rejects below minimum reward", () => {
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.009",
      maxRewardedParticipants: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("0.01 NIM");
  });

  it("rejects malformed decimal (signs/exponents/commas)", () => {
    for (const bad of ["-0.5", "1e3", "1,000", "", "abc", "1.234567"]) {
      const r = validateRewardConfigInput({
        rewardPerParticipant: bad,
        maxRewardedParticipants: 1,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects zero/negative/empty max participants", () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      const r = validateRewardConfigInput({
        rewardPerParticipant: "0.01",
        maxRewardedParticipants: max,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects max participants above the domain ceiling", () => {
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: MAX_REWARDED_PARTICIPANTS + 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("100000");
  });

  it("accepts a sensible cap at the ceiling", () => {
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: MAX_REWARDED_PARTICIPANTS,
    });
    expect(r.ok).toBe(true);
  });
});

describe("principal / fee-reserve / total formulas", () => {
  it("principal = perParticipantLuna × max (exact bigint)", () => {
    // 0.5 NIM = 50,000 Luna × 200 participants = 10,000,000 Luna
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 200,
    });
    expect(r.value?.rewardPerParticipantLuna).toBe(BigInt(50000));
    expect(r.value?.rewardPrincipalLuna).toBe(BigInt(10000000));
  });

  it("fee reserve = ESTIMATED_TX_FEE_LUNA × max × safety multiplier", () => {
    // 4000 × 200 × 2 = 1,600,000 Luna
    expect(computeCampaignFeeReserveLuna(200)).toBe(
      ESTIMATED_TX_FEE_LUNA * BigInt(200) * FEE_RESERVE_SAFETY_MULTIPLIER,
    );
    expect(computeCampaignFeeReserveLuna(200)).toBe(BigInt(1600000));
  });

  it("total required funding = principal + fee reserve (separate, never merged)", () => {
    const r = validateRewardConfigInput({
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 200,
    });
    expect(r.value?.feeReserveLuna).toBe(BigInt(1600000));
    expect(r.value?.totalBudgetLuna).toBe(BigInt(10000000) + BigInt(1600000));
    // fee reserve is never part of principal
    expect(r.value?.totalBudgetLuna).toBe(
      r.value!.rewardPrincipalLuna + r.value!.feeReserveLuna,
    );
  });
});

describe("config mutability / immutability guard", () => {
  it("only 'configured' is mutable", () => {
    expect(CONFIG_MUTABLE_STATES).toEqual(["configured"]);
    expect(isConfigMutable("configured")).toBe(true);
    for (const locked of ["funding_pending", "funded", "rewarding", "exhausted", "closed", "refunding", "refunded", "cancelled"]) {
      expect(isConfigMutable(locked as never)).toBe(false);
    }
  });

  it("assertConfigMutable throws for locked states", () => {
    expect(() => assertConfigMutable("configured")).not.toThrow();
    expect(() => assertConfigMutable("funded" as never)).toThrow(/immutable/);
    expect(() => assertConfigMutable("rewarding" as never)).toThrow(/immutable/);
  });
});
