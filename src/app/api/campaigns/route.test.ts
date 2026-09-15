import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  create: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/campaigns/configuration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns/configuration")>()),
  createParticipationCampaign: mocks.create,
}));

import { POST } from "@/app/api/campaigns/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({
    campaign: {
      campaignId: "campaign-1",
      settlementId: "settlement-1",
      ownerWallet: OWNER,
      status: "draft",
    },
  });
});

describe("POST /api/campaigns", () => {
  it("requires a verified wallet session", async () => {
    mocks.session = null;
    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes only the verified session wallet to the creator boundary", async () => {
    const response = await POST(request({
      type: "public_giveaway",
      title: "A valid giveaway campaign",
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      ownerWallet: "forged-owner",
    }));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a created draft without claim or financial authority fields", async () => {
    const response = await POST(request({
      type: "public_giveaway",
      title: "A valid giveaway campaign",
      visibility: "unlisted",
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
    }));

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(OWNER, expect.any(Object));
    const body = await response.json();
    expect(body.campaign.status).toBe("draft");
    expect(JSON.stringify(body)).not.toContain("claimable");
    expect(JSON.stringify(body)).not.toContain("fundedAmount");
  });

  it("projects the authoritative result to the browser-safe product model", async () => {
    mocks.create.mockResolvedValueOnce({
      campaign: {
        campaignId: "campaign-1",
        settlementId: "settlement-private",
        ownerWallet: OWNER,
        fundingMode: "community",
        fundingWallet: "01" + "b".repeat(38),
        campaignType: "public_giveaway",
        visibility: "unlisted",
        title: "A valid giveaway campaign",
        description: null,
        status: "draft",
        configurationVersion: 1,
        publishedConfigurationVersion: null,
        startsAt: null,
        endsAt: null,
        closeReason: null,
        configurationLockedAt: null,
        publishedAt: null,
        closedAt: null,
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
        reward: {
          rewardPerParticipantLuna: "50000",
          rewardPerParticipantNim: "0.5",
          maxRewardedParticipants: 10,
          rewardPrincipalLuna: "500000",
          rewardPrincipalNim: "5",
          feeReserveLuna: "80000",
          feeReserveNim: "0.8",
          totalBudgetLuna: "580000",
          totalBudgetNim: "5.8",
        },
      },
    });

    const response = await POST(request({ title: "A valid giveaway campaign" }));
    const body = await response.json();

    expect(body.campaign).toMatchObject({
      campaignId: "campaign-1",
      campaignType: "public_giveaway",
      title: "A valid giveaway campaign",
      reward: { rewardPerParticipantNim: "0.5" },
    });
    expect(body.campaign).not.toHaveProperty("settlementId");
    expect(body.campaign).not.toHaveProperty("ownerWallet");
    expect(body.campaign).not.toHaveProperty("fundingWallet");
    expect(body.campaign).not.toHaveProperty("reward.rewardPerParticipantLuna");
    expect(body.campaign).not.toHaveProperty("reward.totalBudgetNim");
  });
});
