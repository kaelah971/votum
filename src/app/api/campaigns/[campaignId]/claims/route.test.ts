import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const CLAIMANT = "02" + "b".repeat(38);
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";
const RECEIPT = "55555555-5555-4555-8555-555555555555";

const mocks = vi.hoisted(() => ({
  session: { address: "02" + "b".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  admin: { marker: "admin" },
  verify: vi.fn(),
  adapterResolve: vi.fn(),
  reserve: vi.fn(),
  executePayout: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", () => ({
  isSameOriginRequest: () => mocks.sameOrigin,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin,
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/claim-challenge", () => ({
  verifyCampaignClaimSignature: (...args: unknown[]) => mocks.verify(...args),
}));

vi.mock("@/lib/rewards/campaign-participation-adapter", () => ({
  createCampaignRewardParticipationAdapter: () => ({ resolveParticipation: mocks.adapterResolve }),
}));

vi.mock("@/lib/campaigns/claim-participation-store", () => ({
  createSupabaseCampaignRewardParticipationStore: () => ({ marker: "campaign-store" }),
}));

vi.mock("@/lib/rewards/reservation-service", () => ({
  createRewardReservationService: () => ({ reserve: mocks.reserve }),
  createSupabaseRewardReservationStore: () => ({ marker: "reservation-store" }),
}));

vi.mock("@/lib/rewards/settlement", () => ({
  createRewardSettlementService: () => ({ executePayout: mocks.executePayout }),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/claims/route";

function context(campaignId = CAMPAIGN) {
  return { params: Promise.resolve({ campaignId }) };
}

function request(body: unknown): Request {
  return new Request(`http://localhost/api/campaigns/${CAMPAIGN}/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signedBody(overrides: Record<string, unknown> = {}) {
  return {
    challengeId: CHALLENGE,
    address: CLAIMANT,
    publicKey: "9".repeat(64),
    signature: "ab".repeat(32),
    ...overrides,
  };
}

function eligibleContext() {
  return {
    source: { type: "campaign_claim", id: CHALLENGE },
    participantWallet: CLAIMANT,
    ownerWallet: OWNER,
    eligibility: { evidenceId: CHALLENGE, evidenceKind: "verified_wallet_claim", verifiedAt: "2026-09-17T00:00:00.000Z" },
    settlement: { id: SETTLEMENT, binding: { sourceType: "campaign_claim", sourceId: CAMPAIGN } },
  };
}

beforeEach(() => {
  mocks.session = { address: CLAIMANT };
  mocks.sameOrigin = true;
  mocks.verify.mockReset();
  mocks.adapterResolve.mockReset();
  mocks.reserve.mockReset();
  mocks.executePayout.mockReset();
  mocks.verify.mockResolvedValue({ kind: "ok", participantWallet: CLAIMANT });
  mocks.adapterResolve.mockResolvedValue({ kind: "eligible", context: eligibleContext() });
  mocks.reserve.mockResolvedValue({
    kind: "reserved",
    settlementId: SETTLEMENT,
    receiptId: RECEIPT,
    receiptStatus: "reserved",
  });
  mocks.executePayout.mockResolvedValue({ kind: "broadcasted" });
});

describe("POST /api/campaigns/[campaignId]/claims", () => {
  it("rejects cross-origin requests and missing sessions before any claim work", async () => {
    mocks.sameOrigin = false;
    const origin = await POST(request(signedBody()), context());
    expect(origin.status).toBe(403);
    expect((await origin.json()).error).toBe("invalid_origin");

    mocks.sameOrigin = true;
    mocks.session = null;
    const session = await POST(request(signedBody()), context());
    expect(session.status).toBe(401);
    expect((await session.json()).error).toBe("session_missing");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies without touching verification", async () => {
    for (const body of [
      {},
      { challengeId: CHALLENGE },
      { challengeId: "", address: CLAIMANT, publicKey: "p", signature: "s" },
      { challengeId: CHALLENGE, address: 42, publicKey: "p", signature: "s" },
      null,
      [],
    ]) {
      const response = await POST(request(body), context());
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error, JSON.stringify(body)).toBe("invalid_request");
    }
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects session/body wallet mismatch without mutating", async () => {
    mocks.session = { address: OWNER };
    const response = await POST(request(signedBody()), context());
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("wallet_mismatch");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("maps every signature verification failure and never reaches reservation", async () => {
    for (const reasonCode of [
      "challenge_invalid",
      "challenge_expired",
      "challenge_consumed",
      "wallet_mismatch",
      "campaign_mismatch",
      "invalid_signature",
    ]) {
      mocks.verify.mockResolvedValue({ kind: "error", reasonCode });
      const response = await POST(request(signedBody()), context());
      expect(response.status, reasonCode).toBe(422);
      expect((await response.json()).error, reasonCode).toBe(reasonCode);
    }
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.executePayout).not.toHaveBeenCalled();
  });

  it("verifies the exact presented bytes against the route campaign", async () => {
    await POST(request(signedBody()), context());
    expect(mocks.verify).toHaveBeenCalledWith(mocks.admin, {
      challengeId: CHALLENGE,
      campaignId: CAMPAIGN,
      address: CLAIMANT,
      publicKey: "9".repeat(64),
      signature: "ab".repeat(32),
    }, { deferConsumedCheck: true });
  });

  it("maps adapter rejection without reaching the mutation", async () => {
    mocks.adapterResolve.mockResolvedValue({ kind: "ineligible", reasonCode: "campaign_not_found", sourceId: CAMPAIGN });
    const missing = await POST(request(signedBody()), context());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("campaign_not_found");
    expect(mocks.reserve).not.toHaveBeenCalled();

    mocks.adapterResolve.mockResolvedValue({ kind: "ineligible", reasonCode: "session_wallet_mismatch", sourceId: CHALLENGE });
    const mismatch = await POST(request(signedBody()), context());
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ error: "claim_not_available", reasonCode: "session_wallet_mismatch" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("maps every reservation rejection onto the shipped claim vocabulary", async () => {
    for (const [reasonCode, status, error, mapped] of [
      ["challenge_invalid", 422, "challenge_invalid", undefined],
      ["challenge_expired", 422, "challenge_expired", undefined],
      ["challenge_consumed", 422, "challenge_consumed", undefined],
      ["campaign_not_found", 404, "campaign_not_found", undefined],
      ["unsupported_type", 422, "claim_not_available", "unsupported_type"],
      ["campaign_not_published", 422, "claim_not_available", "not_published"],
      ["campaign_closed", 422, "claim_not_available", "closed"],
      ["claim_not_started", 422, "claim_not_available", "not_started"],
      ["claim_ended", 422, "claim_not_available", "ended"],
      ["campaign_not_funded", 422, "claim_not_available", "funding_pending"],
      ["creator_not_eligible", 422, "claim_not_available", "creator_ineligible"],
      ["no_reward_capacity", 409, "claim_not_available", "sold_out"],
    ] as const) {
      mocks.reserve.mockResolvedValue({ kind: "ineligible", reasonCode, sourceId: CHALLENGE });
      const response = await POST(request(signedBody()), context());
      expect(response.status, reasonCode).toBe(status);
      const body = await response.json();
      expect(body.error, reasonCode).toBe(error);
      if (mapped !== undefined) expect(body.reasonCode, reasonCode).toBe(mapped);
    }
    expect(mocks.executePayout).not.toHaveBeenCalled();
  });

  it("fails closed on reservation service faults", async () => {
    mocks.reserve.mockResolvedValue({ kind: "rejected", reasonCode: "reservation_failed", sourceId: CHALLENGE });
    const response = await POST(request(signedBody()), context());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("claim_failed");
    expect(mocks.executePayout).not.toHaveBeenCalled();
  });

  it("returns 201 with server-derived identities and enqueues payout once", async () => {
    const response = await POST(
      request({ ...signedBody(), receiptId: "forged", settlementId: "forged", amount_luna: "999" }),
      context(),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ receiptId: RECEIPT, settlementId: SETTLEMENT, status: "reserved", replayed: false });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.executePayout).toHaveBeenCalledTimes(1);
    expect(mocks.executePayout).toHaveBeenCalledWith(SETTLEMENT, RECEIPT);
  });

  it("returns replayed receipts without duplicating work", async () => {
    mocks.reserve.mockResolvedValue({
      kind: "replay",
      settlementId: SETTLEMENT,
      receiptId: RECEIPT,
      receiptStatus: "reserved",
    });
    const response = await POST(request(signedBody()), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      receiptId: RECEIPT,
      settlementId: SETTLEMENT,
      status: "reserved",
      replayed: true,
    });
    expect(mocks.executePayout).toHaveBeenCalledTimes(1);
  });

  it("skips payout for terminal receipts but still returns the receipt", async () => {
    mocks.reserve.mockResolvedValue({
      kind: "replay",
      settlementId: SETTLEMENT,
      receiptId: RECEIPT,
      receiptStatus: "paid",
    });
    const response = await POST(request(signedBody()), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ receiptId: RECEIPT, replayed: true, status: "paid" });
    expect(mocks.executePayout).not.toHaveBeenCalled();
  });

  it("never rolls back a committed reservation when payout enqueue fails", async () => {
    mocks.executePayout.mockRejectedValue(new Error("broadcast down"));
    const response = await POST(request(signedBody()), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ receiptId: RECEIPT, replayed: false });
  });
});
