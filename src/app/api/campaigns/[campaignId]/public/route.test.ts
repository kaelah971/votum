import { beforeEach, describe, expect, it, vi } from "vitest";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  admin: { marker: "admin" },
  projector: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin,
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/public-giveaway", () => ({
  getPublicCampaignGiveaway: (...args: unknown[]) => mocks.projector(...args),
}));

import { GET } from "@/app/api/campaigns/[campaignId]/public/route";

function context(campaignId = CAMPAIGN) {
  return { params: Promise.resolve({ campaignId }) };
}

function openDto() {
  return {
    campaignId: CAMPAIGN,
    campaignType: "public_giveaway",
    visibility: "public",
    title: "Neighborhood cleanup reward",
    description: "Join the Saturday cleanup.",
    creatorDisplay: "NQ32 4Y...b845",
    startsAt: null,
    endsAt: null,
    claimState: "open",
    published: true,
    fundingReady: true,
    rewardPerParticipantNim: "0.5 NIM",
    maxRewardedParticipants: 10,
    remainingRewards: 7,
    reservedCount: 0,
    paidCount: 0,
  };
}

const ALLOWLIST = [
  "campaignId",
  "campaignType",
  "visibility",
  "title",
  "description",
  "creatorDisplay",
  "startsAt",
  "endsAt",
  "claimState",
  "published",
  "fundingReady",
  "rewardPerParticipantNim",
  "maxRewardedParticipants",
  "remainingRewards",
  "reservedCount",
  "paidCount",
].sort();

beforeEach(() => {
  mocks.projector.mockReset();
  mocks.projector.mockResolvedValue(openDto());
});

describe("GET /api/campaigns/[campaignId]/public", () => {
  it("returns 404 for drafts, private, and unknown Campaigns", async () => {
    mocks.projector.mockResolvedValue(null);
    for (const id of ["draft-id", "private-id", "missing-id"]) {
      const response = await GET(new Request("http://localhost"), context(id));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(mocks.projector).toHaveBeenCalledWith(mocks.admin, "missing-id");
  });

  it("returns the exact remaining count with an allowlisted response", async () => {
    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.remainingRewards).toBe(7);
    expect(body.rewardPerParticipantNim).toBe("0.5 NIM");
    expect(Object.keys(body).sort()).toEqual(ALLOWLIST);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "participant_wallet",
      "nonce",
      "ciphertext",
      "private",
      "token",
      "lease",
      "prepared",
      "refund",
      "vault",
      "owner",
      "challenge",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires no session and never queries private tables itself", async () => {
    const response = await GET(new Request("http://localhost"), context());
    expect(response.status).toBe(200);
    expect(mocks.projector).toHaveBeenCalledTimes(1);
  });
});
