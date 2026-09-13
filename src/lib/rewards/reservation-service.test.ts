import { describe, expect, it, vi } from "vitest";
import {
  createRewardReservationService,
  type RewardReservationAuthority,
  type RewardReservationStore,
} from "@/lib/rewards/reservation-service";
import type { RewardParticipationContext } from "@/lib/rewards/participation";

const VOTE_ID = "vote-1";
const POLL_ID = "poll-1";
const CAMPAIGN_ID = "campaign-1";
const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);

function context(): RewardParticipationContext {
  return {
    source: { type: "poll_vote", id: VOTE_ID },
    participantWallet: PARTICIPANT,
    ownerWallet: OWNER,
    eligibility: {
      evidenceId: VOTE_ID,
      evidenceKind: "verified_wallet_vote",
      verifiedAt: "2026-09-13T00:00:00.000Z",
    },
    settlement: {
      id: CAMPAIGN_ID,
      binding: { sourceType: "poll_vote", sourceId: POLL_ID },
    },
  };
}

function authority(overrides: Partial<RewardReservationAuthority> = {}): RewardReservationAuthority {
  return {
    sourceId: VOTE_ID,
    sourceType: "poll_vote",
    settlementId: CAMPAIGN_ID,
    bindingSourceId: POLL_ID,
    participantWallet: PARTICIPANT,
    ownerWallet: OWNER,
    ...overrides,
  };
}

function makeStore(overrides: Partial<RewardReservationStore> = {}) {
  const store: RewardReservationStore = {
    loadAuthority: vi.fn(async () => authority()),
    reserveAtomic: vi.fn(async () => ({
      result_kind: "reserved",
      campaign_id: CAMPAIGN_ID,
      receipt_id: "receipt-1",
      status: "reserved",
      amount_luna: 1,
      option_id: "forbidden-option",
    })),
    ...overrides,
  };

  return { store, service: createRewardReservationService(store) };
}

describe("RewardReservationService", () => {
  it("accepts an eligible context and returns a safe reserved result", async () => {
    const { service } = makeStore();

    await expect(service.reserve(context())).resolves.toEqual({
      kind: "reserved",
      settlementId: CAMPAIGN_ID,
      receiptId: "receipt-1",
      receiptStatus: "reserved",
    });
  });

  it("passes only the context source and settlement IDs to the atomic store", async () => {
    const { service, store } = makeStore();

    await service.reserve(context());

    expect(store.reserveAtomic).toHaveBeenCalledOnce();
    expect(store.reserveAtomic).toHaveBeenCalledWith(VOTE_ID, CAMPAIGN_ID);
    expect(vi.mocked(store.reserveAtomic).mock.calls[0]).toHaveLength(2);
  });

  it("reloads and compares authoritative source, participant, owner, and binding identity", async () => {
    for (const mismatch of [
      { sourceId: "other-vote" },
      { settlementId: "other-campaign" },
      { bindingSourceId: "other-poll" },
      { participantWallet: "03" + "c".repeat(38) },
      { ownerWallet: "03" + "c".repeat(38) },
    ]) {
      const { service, store } = makeStore({
        loadAuthority: vi.fn(async () => authority(mismatch)),
      });

      await expect(service.reserve(context())).resolves.toMatchObject({
        kind: "ineligible",
        reasonCode: "authority_mismatch",
        sourceId: VOTE_ID,
      });
      expect(store.reserveAtomic).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed or non-Poll contexts before financial mutation", async () => {
    const { service, store } = makeStore();
    const forged = {
      ...context(),
      source: { type: "campaign_claim", id: VOTE_ID },
      eligibility: { ...context().eligibility, evidenceKind: "verified_wallet_claim" },
      rewardAmountLuna: 1,
    };

    await expect(service.reserve(forged as unknown as RewardParticipationContext)).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_context",
    });
    expect(store.loadAuthority).not.toHaveBeenCalled();
    expect(store.reserveAtomic).not.toHaveBeenCalled();
  });

  it("reloads financial authority in the atomic store and never exposes RPC economics", async () => {
    const { service } = makeStore({
      reserveAtomic: vi.fn(async () => ({
        result_kind: "replay",
        campaign_id: CAMPAIGN_ID,
        receipt_id: "receipt-1",
        status: "paid",
        amount_luna: 999999,
        max_rewarded_participants: 1,
        first_reservation_at: "forged",
        vault_address_hex: "forged",
      })),
    });

    const result = await service.reserve(context());

    expect(result).toEqual({
      kind: "replay",
      settlementId: CAMPAIGN_ID,
      receiptId: "receipt-1",
      receiptStatus: "paid",
    });
    expect(result).not.toHaveProperty("amountLuna");
    expect(result).not.toHaveProperty("capacity");
    expect(result).not.toHaveProperty("firstReservationAt");
    expect(result).not.toHaveProperty("vaultAddressHex");
  });

  it.each([
    "creator_not_reward_eligible",
    "poll_not_rewarded",
    "poll_not_public",
    "campaign_not_funded",
    "campaign_not_reservable",
    "no_reward_capacity",
  ])("preserves the existing ineligible result without a receipt: %s", async (resultKind) => {
    const { service } = makeStore({
      reserveAtomic: vi.fn(async () => ({
        result_kind: resultKind,
        campaign_id: CAMPAIGN_ID,
      })),
    });

    await expect(service.reserve(context())).resolves.toEqual({
      kind: "ineligible",
      reasonCode: resultKind,
      sourceId: VOTE_ID,
    });
  });

  it("returns replay identity and status without selected-option data", async () => {
    const { service } = makeStore({
      reserveAtomic: vi.fn(async () => ({
        result_kind: "replay",
        campaign_id: CAMPAIGN_ID,
        receipt_id: "receipt-1",
        status: "payout_pending",
        selected_option_id: "forbidden-option",
        amount_luna: 5000,
      })),
    });

    const result = await service.reserve(context());

    expect(result).toEqual({
      kind: "replay",
      settlementId: CAMPAIGN_ID,
      receiptId: "receipt-1",
      receiptStatus: "payout_pending",
    });
    expect(JSON.stringify(result)).not.toMatch(/option|amount|capacity|vault|funding/i);
  });

  it("fails closed for malformed or settlement-mismatched atomic results", async () => {
    for (const response of [
      null,
      { result_kind: "reserved", campaign_id: "other-campaign", receipt_id: "receipt-1", status: "reserved" },
      { result_kind: "reserved", campaign_id: CAMPAIGN_ID, receipt_id: "", status: "reserved" },
      { result_kind: "reserved", campaign_id: CAMPAIGN_ID, receipt_id: "receipt-1", status: "unknown" },
    ]) {
      const { service } = makeStore({
        reserveAtomic: vi.fn(async () => response),
      });

      await expect(service.reserve(context())).resolves.toMatchObject({
        kind: "rejected",
        reasonCode: "invalid_reservation_result",
        sourceId: VOTE_ID,
      });
    }
  });

  it("maps an atomic reservation failure to a best-effort rejected result", async () => {
    const { service } = makeStore({
      reserveAtomic: vi.fn(async () => {
        throw new Error("rpc_unavailable");
      }),
    });

    await expect(service.reserve(context())).resolves.toEqual({
      kind: "rejected",
      reasonCode: "reservation_failed",
      sourceId: VOTE_ID,
    });
  });
});
