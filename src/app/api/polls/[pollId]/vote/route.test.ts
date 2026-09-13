import { beforeEach, describe, expect, it, vi } from "vitest";

const VOTER = "01" + "a".repeat(38);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  voteResult: {
    result_kind: "created" as "created" | "replay",
    vote_id: "vote-1",
    created_at: "2026-09-12T00:00:00.000Z",
  },
  rpc: vi.fn(),
  resolveParticipation: vi.fn(),
  reserve: vi.fn(),
  payout: vi.fn(),
  adapterFactory: vi.fn(),
  adapterStoreFactory: vi.fn(),
  reservationServiceFactory: vi.fn(),
  reservationStoreFactory: vi.fn(),
  context: {
    source: { type: "poll_vote", id: "vote-1" },
    participantWallet: "01" + "a".repeat(38),
    ownerWallet: "02" + "b".repeat(38),
    eligibility: {
      evidenceId: "vote-1",
      evidenceKind: "verified_wallet_vote",
      verifiedAt: "2026-09-13T00:00:00.000Z",
    },
    settlement: {
      id: "campaign-1",
      binding: { sourceType: "poll_vote", sourceId: "poll-1" },
    },
  },
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminConfigStatus: () => ({ configured: true }),
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

vi.mock("@/lib/rewards/poll-participation-adapter", () => ({
  createPollRewardParticipationAdapter: mocks.adapterFactory,
  createSupabasePollRewardParticipationStore: mocks.adapterStoreFactory,
}));

vi.mock("@/lib/rewards/reservation-service", () => ({
  createRewardReservationService: mocks.reservationServiceFactory,
  createSupabaseRewardReservationStore: mocks.reservationStoreFactory,
}));

vi.mock("@/lib/rewards/payout", () => ({
  executeReservedRewardPayout: mocks.payout,
}));

import { POST } from "@/app/api/polls/[pollId]/vote/route";

beforeEach(() => {
  mocks.session = { address: VOTER };
  mocks.voteResult = {
    result_kind: "created",
    vote_id: "vote-1",
    created_at: "2026-09-12T00:00:00.000Z",
  };
  mocks.rpc.mockReset();
  mocks.resolveParticipation.mockReset();
  mocks.reserve.mockReset();
  mocks.payout.mockReset();
  mocks.adapterFactory.mockReset();
  mocks.adapterStoreFactory.mockReset();
  mocks.reservationServiceFactory.mockReset();
  mocks.reservationStoreFactory.mockReset();

  mocks.rpc.mockImplementation(async () => ({ data: mocks.voteResult, error: null }));
  mocks.resolveParticipation.mockResolvedValue({ kind: "eligible", context: mocks.context });
  mocks.reserve.mockResolvedValue({
    kind: "rejected",
    reasonCode: "reservation_failed",
    sourceId: "vote-1",
  });
  mocks.payout.mockResolvedValue({ kind: "broadcasted", attemptId: "attempt-1", transactionHash: "a".repeat(64) });
  mocks.adapterFactory.mockReturnValue({ resolveParticipation: mocks.resolveParticipation });
  mocks.reservationServiceFactory.mockReturnValue({ reserve: mocks.reserve });
  mocks.adapterStoreFactory.mockReturnValue({});
  mocks.reservationStoreFactory.mockReturnValue({});
});

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/polls/poll-1/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/polls/[pollId]/vote compatibility boundary", () => {
  it("resolves participation through the adapter and keeps a valid vote when reservation fails", async () => {
    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      resultKind: "created",
      vote: { id: "vote-1", optionId: "option-a" },
    });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.adapterFactory).toHaveBeenCalledOnce();
    expect(mocks.resolveParticipation).toHaveBeenCalledWith({
      pollId: "poll-1",
      participationId: "vote-1",
      verifiedSession: { address: VOTER },
    });
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.context);
    expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("automatically pays only a reserved or replayed receipt using its settlement ID", async () => {
    mocks.reserve.mockResolvedValue({
      kind: "reserved",
      settlementId: "campaign-1",
      receiptId: "receipt-1",
      receiptStatus: "reserved",
    });

    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.payout).toHaveBeenCalledWith(expect.anything(), "receipt-1", "campaign-1");
  });

  it("preserves replay vote behavior and attempts payout for a replay receipt", async () => {
    mocks.voteResult = { result_kind: "replay", vote_id: "vote-1", created_at: "2026-09-12T00:00:00.000Z" };
    mocks.reserve.mockResolvedValue({
      kind: "replay",
      settlementId: "campaign-1",
      receiptId: "receipt-1",
      receiptStatus: "payout_pending",
    });

    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resultKind: "replay",
      vote: { id: "vote-1", pollId: "poll-1", optionId: "option-a" },
    });
    expect(mocks.payout).toHaveBeenCalledWith(expect.anything(), "receipt-1", "campaign-1");
  });

  it("does no reservation work when the adapter excludes a free Poll", async () => {
    mocks.resolveParticipation.mockResolvedValue({
      kind: "ineligible",
      reasonCode: "poll_not_rewarded",
      sourceId: "vote-1",
    });

    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("does not pass client option, amount, owner, recipient, capacity, or vault fields to reward work", async () => {
    const response = await POST(request({
      optionId: "option-a",
      selectedOptionId: "option-a",
      rewardAmountLuna: 1,
      ownerWallet: "browser-owner",
      participantWallet: "browser-participant",
      capacity: 1,
      vaultAddressHex: "browser-vault",
    }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.context);
    expect(JSON.stringify(mocks.reserve.mock.calls[0][0])).not.toMatch(/option|amount|capacity|vault|browser/i);
  });
});
