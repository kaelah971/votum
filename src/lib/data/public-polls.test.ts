import { describe, expect, it } from "vitest";
import {
  mapPollRow,
  mapPublicRewardCampaign,
} from "@/lib/data/public-polls";
import type { Database } from "@/types/database";

type PollRow = Database["public"]["Tables"]["polls"]["Row"];

function row(overrides: Partial<PollRow>): PollRow {
  return {
    id: "poll-1",
    question: "Which option should ship next?",
    description: "A decision context",
    mode: "creator_support",
    destination_wallet: "00".repeat(20),
    destination_purpose: "Project costs",
    min_nim_luna: 1000,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    starts_at: null,
    ends_at: "2026-09-07T00:00:00.000Z",
    is_public: true,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    published_at: "2026-08-31T00:00:00.000Z",
    category: "communities",
    format: "decision",
    economic_model: "legacy_support",
    reward_mode: null,
    creator_wallet: "11".repeat(20),
    ...overrides,
  };
}

const options = [
  { id: "option-a", poll_id: "poll-1", label: "A", sort_order: 0, created_at: "2026-08-31T00:00:00.000Z" },
  { id: "option-b", poll_id: "poll-1", label: "B", sort_order: 1, created_at: "2026-08-31T00:00:00.000Z" },
];

describe("public poll mapping", () => {
  it("maps legacy rows with their support fields", () => {
    const poll = mapPollRow(row({}), options);

    expect(poll).toMatchObject({
      economicModel: "legacy_support",
      rewardMode: null,
      contributionMode: "creator",
      destinationPurpose: "Project costs",
      minimumNim: 0.01,
    });
  });

  it("maps free reward-first rows without support-shaped fields", () => {
    const poll = mapPollRow(
      row({
        mode: null,
        destination_wallet: null,
        destination_purpose: null,
        min_nim_luna: null,
        economic_model: "reward_first",
        reward_mode: "free",
      }),
      options,
    );

    expect(poll).toMatchObject({ economicModel: "reward_first", rewardMode: "free" });
    expect(poll).not.toHaveProperty("destinationWallet");
    expect(poll).not.toHaveProperty("minimumNim");
  });

  it("only exposes a funded safe reward campaign", () => {
    const campaign = mapPublicRewardCampaign({
      result_kind: "found",
      pollId: "poll-1",
      campaignId: "campaign-1",
      status: "funded",
      rewardPerParticipantLuna: "1000",
      maxRewardedParticipants: 10,
      rewardPrincipalLuna: "10000",
      rewardsRemaining: 10,
      funded: true,
      vaultAddressHex: "private material must not escape",
    });
    expect(campaign).toEqual({
      pollId: "poll-1",
      campaignId: "campaign-1",
      status: "funded",
      rewardPerParticipantLuna: "1000",
      maxRewardedParticipants: 10,
      rewardPrincipalLuna: "10000",
      rewardsRemaining: 10,
      funded: true,
    });

    expect(
      mapPublicRewardCampaign({
        result_kind: "found",
        pollId: "poll-1",
        campaignId: "campaign-1",
        status: "funding_pending",
        rewardPerParticipantLuna: "1000",
        maxRewardedParticipants: 10,
        rewardPrincipalLuna: "10000",
        rewardsRemaining: 10,
        funded: false,
      }),
    ).toBeUndefined();
  });

  it("fails closed for an unknown discriminator", () => {
    expect(mapPollRow(row({ economic_model: "unknown" as PollRow["economic_model"] }), options)).toBeNull();
  });
});
