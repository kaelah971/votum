import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRewardReservationService,
  type RewardReservationStore,
} from "@/lib/rewards/reservation-service";
import type { RewardParticipationContext } from "@/lib/rewards/participation";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";
const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";
const RECEIPT = "55555555-5555-4555-8555-555555555555";

function campaignContext(): RewardParticipationContext {
  return {
    source: { type: "campaign_claim", id: CHALLENGE },
    participantWallet: PARTICIPANT,
    ownerWallet: OWNER,
    eligibility: {
      evidenceId: CHALLENGE,
      evidenceKind: "verified_wallet_claim",
      verifiedAt: "2026-09-17T00:00:00.000Z",
    },
    settlement: {
      id: SETTLEMENT,
      binding: { sourceType: "campaign_claim", sourceId: CAMPAIGN },
    },
  };
}

function campaignAuthority() {
  return {
    sourceId: CHALLENGE,
    sourceType: "campaign_claim" as const,
    settlementId: SETTLEMENT,
    bindingSourceId: CAMPAIGN,
    participantWallet: PARTICIPANT,
    ownerWallet: OWNER,
  };
}

function store(overrides: Partial<RewardReservationStore> = {}): RewardReservationStore {
  return {
    loadAuthority: vi.fn(async () => campaignAuthority()),
    reserveAtomic: vi.fn(async () => { throw new Error("poll path must not run for campaigns"); }),
    reserveCampaignAtomic: vi.fn(async () => ({
      result_kind: "reserved",
      receipt_id: RECEIPT,
      campaign_id: CAMPAIGN,
      settlement_id: SETTLEMENT,
      participant_wallet: PARTICIPANT,
      amount_luna: 50000,
      status: "reserved",
    })),
    ...overrides,
  };
}

describe("createRewardReservationService campaign branch", () => {
  it("reserves a Campaign claim through claim_campaign_reward_atomic", async () => {
    const stub = store();
    const service = createRewardReservationService(stub);

    const result = await service.reserve(campaignContext());

    expect(result).toEqual({
      kind: "reserved",
      settlementId: SETTLEMENT,
      receiptId: RECEIPT,
      receiptStatus: "reserved",
    });
    expect(stub.reserveCampaignAtomic).toHaveBeenCalledWith({
      campaignId: CAMPAIGN,
      participantWallet: PARTICIPANT,
      challengeId: CHALLENGE,
    });
    expect(stub.reserveAtomic).not.toHaveBeenCalled();
  });

  it("preserves receipt identity on replay", async () => {
    const stub = store({
      reserveCampaignAtomic: vi.fn(async () => ({
        result_kind: "replay",
        receipt_id: RECEIPT,
        campaign_id: CAMPAIGN,
        settlement_id: SETTLEMENT,
        participant_wallet: PARTICIPANT,
        amount_luna: 50000,
        status: "reserved",
      })),
    });
    const service = createRewardReservationService(stub);

    await expect(service.reserve(campaignContext())).resolves.toEqual({
      kind: "replay",
      settlementId: SETTLEMENT,
      receiptId: RECEIPT,
      receiptStatus: "reserved",
    });
  });

  it("maps every deterministic M3 rejection into the domain shape", async () => {
    for (const reasonCode of [
      "challenge_invalid",
      "challenge_expired",
      "challenge_consumed",
      "campaign_not_found",
      "unsupported_type",
      "campaign_not_published",
      "campaign_closed",
      "claim_not_started",
      "claim_ended",
      "campaign_not_funded",
      "creator_not_eligible",
      "no_reward_capacity",
    ]) {
      const stub = store({ reserveCampaignAtomic: vi.fn(async () => ({ result_kind: reasonCode })) });
      const service = createRewardReservationService(stub);
      await expect(service.reserve(campaignContext()), reasonCode).resolves.toEqual({
        kind: "ineligible",
        reasonCode,
        sourceId: CHALLENGE,
      });
    }
  });

  it("rejects malformed campaign contexts and authority mismatches", async () => {
    const service = createRewardReservationService(store());
    const mismatchedEvidence = { ...campaignContext(), eligibility: { ...campaignContext().eligibility, evidenceKind: "verified_wallet_vote" as const } };
    await expect(service.reserve(mismatchedEvidence)).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_context",
    });

    const badAuthority = store({
      loadAuthority: vi.fn(async () => ({ ...campaignAuthority(), participantWallet: OWNER })),
    });
    await expect(createRewardReservationService(badAuthority).reserve(campaignContext())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "authority_mismatch",
    });

    const failing = store({ reserveCampaignAtomic: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(createRewardReservationService(failing).reserve(campaignContext())).resolves.toMatchObject({
      kind: "rejected",
      reasonCode: "reservation_failed",
    });

    const malformed = store({ reserveCampaignAtomic: vi.fn(async () => ({ result_kind: "reserved" })) });
    await expect(createRewardReservationService(malformed).reserve(campaignContext())).resolves.toMatchObject({
      kind: "rejected",
      reasonCode: "invalid_reservation_result",
    });
  });

  it("keeps the Poll path byte-identical in behavior", async () => {
    const pollContext: RewardParticipationContext = {
      source: { type: "poll_vote", id: "vote-1" },
      participantWallet: PARTICIPANT,
      ownerWallet: OWNER,
      eligibility: { evidenceId: "vote-1", evidenceKind: "verified_wallet_vote", verifiedAt: "2026-09-17T00:00:00.000Z" },
      settlement: { id: SETTLEMENT, binding: { sourceType: "poll_vote", sourceId: "poll-1" } },
    };
    const stub: RewardReservationStore = {
      loadAuthority: vi.fn(async () => ({
        sourceId: "vote-1",
        sourceType: "poll_vote" as const,
        settlementId: SETTLEMENT,
        bindingSourceId: "poll-1",
        participantWallet: PARTICIPANT,
        ownerWallet: OWNER,
      })),
      reserveAtomic: vi.fn(async () => ({
        result_kind: "reserved",
        receipt_id: RECEIPT,
        campaign_id: SETTLEMENT,
        settlement_id: SETTLEMENT,
        poll_id: "poll-1",
        status: "reserved",
      })),
    };
    const service = createRewardReservationService(stub);
    await expect(service.reserve(pollContext)).resolves.toEqual({
      kind: "reserved",
      settlementId: SETTLEMENT,
      receiptId: RECEIPT,
      receiptStatus: "reserved",
    });
    expect(stub.reserveAtomic).toHaveBeenCalledWith("vote-1", SETTLEMENT);
  });

  it("performs no receipt, consumption, capacity, or payout writes in the service layer", () => {
    const serviceSource = readFileSync(resolve(process.cwd(), "src/lib/rewards/reservation-service.ts"), "utf8");
    expect(serviceSource).not.toContain('from("reward_receipts")');
    expect(serviceSource).not.toContain("consumed_at");
    expect(serviceSource).not.toContain("executePayout");
    expect(serviceSource).not.toContain("executeReservedRewardPayout");
    expect(serviceSource).not.toContain("rewarded_participant_count");
  });
});
