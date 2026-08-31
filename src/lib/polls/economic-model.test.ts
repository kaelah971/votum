import { describe, expect, it } from "vitest";
import {
  LEGACY_SUPPORT_ENABLED,
  NEW_REWARD_FIRST_POLL,
  isPollEconomicModel,
  isRewardFirstMode,
  isRewardFundingMode,
  validateEconomicModelInput,
} from "@/lib/polls/economic-model";

describe("poll economic model", () => {
  it("accepts only the explicit legacy and reward-first discriminators", () => {
    expect(isPollEconomicModel(LEGACY_SUPPORT_ENABLED)).toBe(true);
    expect(isPollEconomicModel(NEW_REWARD_FIRST_POLL)).toBe(true);
    expect(isPollEconomicModel("creator_support")).toBe(false);
  });

  it("accepts only free and rewarded reward-first modes", () => {
    expect(isRewardFirstMode("free")).toBe(true);
    expect(isRewardFirstMode("rewarded")).toBe(true);
    expect(isRewardFirstMode("creator_support")).toBe(false);
  });

  it("accepts only creator and community reward funding modes", () => {
    expect(isRewardFundingMode("creator")).toBe(true);
    expect(isRewardFundingMode("community")).toBe(true);
    expect(isRewardFundingMode("supporter")).toBe(false);
  });

  it("validates a free reward-first payload without support configuration", () => {
    expect(
      validateEconomicModelInput({
        economicModel: NEW_REWARD_FIRST_POLL,
        rewardMode: "free",
      }),
    ).toEqual({ ok: true, economicModel: NEW_REWARD_FIRST_POLL, rewardMode: "free" });
  });

  it("validates a creator-funded rewarded payload", () => {
    expect(
      validateEconomicModelInput({
        economicModel: NEW_REWARD_FIRST_POLL,
        rewardMode: "rewarded",
        reward: { fundingMode: "creator", fundingWallet: "" },
      }),
    ).toEqual({
      ok: true,
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "rewarded",
      fundingMode: "creator",
      fundingWallet: "",
    });
  });

  it("defaults creator funding to the verified creator wallet", () => {
    expect(
      validateEconomicModelInput({
        economicModel: NEW_REWARD_FIRST_POLL,
        rewardMode: "rewarded",
        creatorWallet: "NQ-CREATOR",
        reward: { fundingMode: "creator" },
      }),
    ).toEqual({
      ok: true,
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "rewarded",
      fundingMode: "creator",
      fundingWallet: "NQ-CREATOR",
    });
  });

  it("requires a reward configuration for rewarded mode", () => {
    const result = validateEconomicModelInput({
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "rewarded",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("fundingMode");
  });

  it("rejects reward configuration for free mode", () => {
    const result = validateEconomicModelInput({
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "free",
      reward: { fundingMode: "creator" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("reward");
  });

  it("requires a designated wallet for community-funded rewards", () => {
    const result = validateEconomicModelInput({
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "rewarded",
      reward: { fundingMode: "community", fundingWallet: "   " },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("fundingWallet");
  });

  it("rejects participant support fields on reward-first payloads", () => {
    const result = validateEconomicModelInput({
      economicModel: NEW_REWARD_FIRST_POLL,
      rewardMode: "free",
      mode: "creator",
      destinationWallet: "NQ...",
      destinationPurpose: "old support",
      minimumNim: "1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("legacySupportFields");
  });

  it("requires legacy support fields for the legacy model", () => {
    const result = validateEconomicModelInput({
      economicModel: LEGACY_SUPPORT_ENABLED,
      rewardMode: null,
      mode: "creator",
      destinationWallet: "NQ...",
      destinationPurpose: "old support",
      minimumNim: "1",
    });

    expect(result).toEqual({
      ok: true,
      economicModel: LEGACY_SUPPORT_ENABLED,
      rewardMode: null,
    });
  });

  it("rejects an explicit malformed economic model", () => {
    expect(
      validateEconomicModelInput({ economicModel: "unknown" }),
    ).toEqual({ ok: false, errors: ["economicModel"] });
  });
});
