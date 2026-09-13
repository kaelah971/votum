import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateRewardEligibility,
  type RewardCampaignForEligibility,
  type RewardEligibilityInput,
  type RewardPollForEligibility,
  type RewardReceiptForEligibility,
} from "@/lib/rewards/eligibility";

const POLL_ID = "poll-eligibility-1";
const CAMPAIGN_ID = "campaign-eligibility-1";
const PARTICIPATION_ID = "vote-eligibility-1";
const CREATOR = "01" + "a".repeat(38);
const PARTICIPANT = "01" + "b".repeat(38);

function makeInput(overrides: {
  poll?: Partial<RewardPollForEligibility>;
  campaign?: Partial<RewardCampaignForEligibility> | null;
  participation?: Partial<RewardEligibilityInput["participation"]>;
  existingReceipt?: RewardReceiptForEligibility | null;
  clientRewardAmountLuna?: unknown;
} = {}): RewardEligibilityInput {
  const campaign = overrides.campaign === null
    ? null
    : {
        id: CAMPAIGN_ID,
        pollId: POLL_ID,
        status: "funded" as const,
        rewardPerParticipantLuna: BigInt(5000),
        maxRewardedParticipants: 3,
        rewardedParticipantCount: 0,
        firstReservationAt: null,
        creatorWallet: CREATOR,
        ...overrides.campaign,
      };

  return {
    poll: {
      id: POLL_ID,
      economicModel: "reward_first",
      rewardMode: "rewarded",
      isPublic: true,
      status: "live",
      creatorWallet: CREATOR,
      ...overrides.poll,
    },
    campaign,
    participation: {
      id: PARTICIPATION_ID,
      pollId: POLL_ID,
      participantWallet: PARTICIPANT,
      committed: true,
      walletVerified: true,
      selectedOptionId: "option-a",
      ...overrides.participation,
    },
    existingReceipt: overrides.existingReceipt ?? null,
    clientRewardAmountLuna: overrides.clientRewardAmountLuna,
  };
}

describe("evaluateRewardEligibility", () => {
  it("returns eligible for a verified committed participant", () => {
    const result = evaluateRewardEligibility(makeInput());

    expect(result).toMatchObject({
      status: "eligible",
      reasonCode: "eligible",
      rewardAmountLuna: BigInt(5000),
      reservationStatus: "reserved",
      remainingCapacity: 3,
      shouldSetFirstReservationAt: true,
      nextCampaignState: "rewarding",
    });
  });

  it("excludes the creator without invalidating the creator vote", () => {
    const result = evaluateRewardEligibility(makeInput({
      participation: { participantWallet: CREATOR },
    }));

    expect(result).toMatchObject({
      status: "ineligible",
      reasonCode: "creator_not_reward_eligible",
    });
  });

  it("is independent of the selected option", () => {
    const optionA = evaluateRewardEligibility(makeInput({
      participation: { selectedOptionId: "option-a" },
    }));
    const optionB = evaluateRewardEligibility(makeInput({
      participation: { selectedOptionId: "option-b" },
    }));

    expect(optionB).toEqual(optionA);
  });

  it("rejects a free verified poll as not rewarded", () => {
    const result = evaluateRewardEligibility(makeInput({
      poll: { rewardMode: "free" },
      campaign: null,
    }));

    expect(result).toMatchObject({ status: "ineligible", reasonCode: "poll_not_rewarded" });
  });

  it("rejects a legacy-support poll even when a historical campaign row exists", () => {
    const result = evaluateRewardEligibility(makeInput({
      poll: { economicModel: "legacy_support", rewardMode: null },
    }));

    expect(result).toMatchObject({ status: "ineligible", reasonCode: "poll_not_rewarded" });
  });

  it("rejects a non-public rewarded poll", () => {
    const result = evaluateRewardEligibility(makeInput({
      poll: { isPublic: false },
    }));

    expect(result).toMatchObject({ status: "ineligible", reasonCode: "poll_not_public" });
  });

  it.each(["configured", "funding_pending", "cancelled"] as const)(
    "rejects a campaign that is not funded: %s",
    (status) => {
      const result = evaluateRewardEligibility(makeInput({ campaign: { status } }));

      expect(result).toMatchObject({ status: "ineligible", reasonCode: "campaign_not_funded" });
    },
  );

  it("returns no capacity for an exhausted campaign", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { status: "exhausted", rewardedParticipantCount: 3 },
    }));

    expect(result).toMatchObject({ status: "no_capacity", reasonCode: "no_reward_capacity" });
  });

  it("returns the authoritative existing reservation idempotently", () => {
    const receipt: RewardReceiptForEligibility = {
      id: "receipt-1",
      campaignId: CAMPAIGN_ID,
      participantWallet: PARTICIPANT,
      amountLuna: BigInt(5000),
      status: "reserved",
    };
    const result = evaluateRewardEligibility(makeInput({ existingReceipt: receipt }));

    expect(result).toMatchObject({
      status: "already_reserved",
      reasonCode: "already_rewarded_or_reserved",
      receiptId: "receipt-1",
      rewardAmountLuna: BigInt(5000),
    });
  });

  it("rejects invalid or uncommitted participation", () => {
    const result = evaluateRewardEligibility(makeInput({
      participation: { committed: false },
    }));

    expect(result).toMatchObject({ status: "ineligible", reasonCode: "invalid_participation" });
  });

  it("takes the reward amount from immutable campaign terms", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { rewardPerParticipantLuna: BigInt(7500) },
    }));

    expect(result).toMatchObject({ status: "eligible", rewardAmountLuna: BigInt(7500) });
  });

  it("cannot be influenced by a browser-supplied reward amount", () => {
    const low = evaluateRewardEligibility(makeInput({ clientRewardAmountLuna: BigInt(1) }));
    const high = evaluateRewardEligibility(makeInput({ clientRewardAmountLuna: BigInt(999999999) }));

    expect(high).toEqual(low);
    expect(high).toMatchObject({ rewardAmountLuna: BigInt(5000) });
  });

  it("returns no selected-option data", () => {
    const result = evaluateRewardEligibility(makeInput());

    expect(Object.keys(result)).not.toContain("selectedOptionId");
    expect(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("option");
  });

  it("uses integer campaign counts for capacity", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { rewardedParticipantCount: 1 },
    }));

    expect(result).toMatchObject({ status: "eligible", remainingCapacity: 2 });
    if (result.status === "eligible") expect(Number.isInteger(result.remainingCapacity)).toBe(true);
  });

  it("never evaluates a zero-capacity campaign as eligible", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { maxRewardedParticipants: 0 },
    }));

    expect(result).toMatchObject({ status: "no_capacity", reasonCode: "no_reward_capacity" });
  });

  it("marks the first reservation boundary without mutating input", () => {
    const input = makeInput();
    const result = evaluateRewardEligibility(input);

    expect(result).toMatchObject({ shouldSetFirstReservationAt: true });
    expect(input.campaign?.firstReservationAt).toBeNull();
  });

  it("does not reset an existing first reservation boundary", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { firstReservationAt: "2026-09-06T00:00:00.000Z" },
    }));

    expect(result).toMatchObject({
      status: "eligible",
      shouldSetFirstReservationAt: false,
    });
  });

  it("returns exhausted as the next state when the final slot is reserved", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { maxRewardedParticipants: 1 },
    }));

    expect(result).toMatchObject({
      status: "eligible",
      remainingCapacity: 1,
      nextCampaignState: "exhausted",
    });
  });

  it("allows reservations while the campaign is already rewarding", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { status: "rewarding", rewardedParticipantCount: 1 },
    }));

    expect(result).toMatchObject({ status: "eligible", nextCampaignState: "rewarding" });
  });

  it("rejects a campaign attached to a different poll", () => {
    const result = evaluateRewardEligibility(makeInput({
      campaign: { pollId: "another-poll" },
    }));

    expect(result).toMatchObject({ status: "ineligible", reasonCode: "campaign_not_reservable" });
  });

  it("is deterministic for identical inputs", () => {
    const input = makeInput({ campaign: { rewardedParticipantCount: 1 } });

    expect(evaluateRewardEligibility(input)).toEqual(evaluateRewardEligibility(input));
  });

  it("contains no payout, signing, broadcasting, or vault dependency", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/rewards/eligibility.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/vault|sign|broadcast|sendTransaction|payout/i);
  });
});
