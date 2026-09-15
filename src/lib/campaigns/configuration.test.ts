import { describe, expect, it } from "vitest";
import {
  parseCampaignConfigurationInput,
  type CampaignConfigurationInput,
} from "@/lib/campaigns/configuration";

const OWNER = "01" + "a".repeat(38);
const FUNDER = "01" + "b".repeat(38);

function input(overrides: Partial<CampaignConfigurationInput> = {}): CampaignConfigurationInput {
  return {
    type: "public_giveaway",
    title: "A valid giveaway campaign",
    description: "A product configuration fixture.",
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
    ...overrides,
  };
}

describe("Campaign configuration validation", () => {
  it("derives integer-Luna economics from creator input", () => {
    const result = parseCampaignConfigurationInput(input(), OWNER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      ownerWallet: OWNER,
      fundingMode: "creator",
      fundingWallet: OWNER,
      rewardPerParticipantLuna: BigInt(50000),
      maxRewardedParticipants: 10,
      rewardPrincipalLuna: BigInt(500000),
      feeReserveLuna: BigInt(80000),
      totalBudgetLuna: BigInt(580000),
      refundRecipientWallet: OWNER,
    });
  });

  it("accepts a normalized designated funder only for community funding", () => {
    const result = parseCampaignConfigurationInput(input({
      fundingMode: "community",
      fundingWallet: FUNDER.toUpperCase(),
    }), OWNER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fundingWallet).toBe(FUNDER);
    expect(result.value.refundRecipientWallet).toBe(OWNER);
  });

  it("rejects creator funding that names another wallet", () => {
    const result = parseCampaignConfigurationInput(input({ fundingWallet: FUNDER }), OWNER);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "fundingWallet" }));
  });

  it("rejects unsafe economics and browser-authored financial snapshots", () => {
    const result = parseCampaignConfigurationInput(input({
      rewardPerParticipant: "1e3",
      maxRewardedParticipants: "10.5",
      rewardPrincipalLuna: "forged",
      feeReserveLuna: "forged",
      totalBudgetLuna: "forged",
      settlementId: "forged",
      refundRecipientWallet: FUNDER,
    } as Partial<CampaignConfigurationInput> & Record<string, unknown>), OWNER);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      "rewardPerParticipant",
      "maxRewardedParticipants",
      "rewardPrincipalLuna",
      "feeReserveLuna",
      "totalBudgetLuna",
      "settlementId",
      "refundRecipientWallet",
    ]));
  });

  it("rejects snake-case authority aliases instead of silently ignoring them", () => {
    const result = parseCampaignConfigurationInput(input({
      settlement_id: "forged",
      reward_principal_luna: "forged",
    } as Partial<CampaignConfigurationInput> & Record<string, unknown>), OWNER);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      "settlement_id",
      "reward_principal_luna",
    ]));
  });

  it("rejects derived economics that exceed PostgreSQL bigint range", () => {
    const result = parseCampaignConfigurationInput(input({
      rewardPerParticipant: "92233720368547.75807",
      maxRewardedParticipants: 2,
    }), OWNER);

    expect(result.ok).toBe(false);
  });

  it("rejects invalid product values and windows", () => {
    for (const overrides of [
      { type: "unsupported" },
      { visibility: "hidden" },
      { title: "" },
      { title: "x".repeat(161) },
      { description: "x".repeat(4001) },
      { startsAt: "2026-10-02T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" },
      { startsAt: "not-a-date" },
    ]) {
      const result = parseCampaignConfigurationInput(input(overrides), OWNER);
      expect(result.ok).toBe(false);
    }
  });

  it("keeps every approved type storable while readiness stays unsupported", () => {
    for (const type of [
      "public_giveaway",
      "secret_drop",
      "private_drop",
      "event_drop",
      "community_reward",
    ] as const) {
      const result = parseCampaignConfigurationInput(input({ type }), OWNER);
      expect(result.ok).toBe(true);
    }
  });
});
