import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  bindCampaignFunding,
  closeCampaign,
  confirmCampaignFunding,
  createCampaign,
  createCampaignFundingIntent,
  getCampaignFundingReadiness,
  getPublicCampaign,
  publishCampaign,
  refundCampaign,
  updateCampaign,
} from "@/lib/campaigns/creator-client";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function campaignBody() {
  return {
    campaign: {
      campaignId: CAMPAIGN,
      campaignType: "public_giveaway",
      visibility: "public",
      title: "Neighborhood cleanup reward",
      status: "draft",
    },
  };
}

beforeEach(() => {
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("creator-client request shapes", () => {
  it("creates campaigns with exact path, method, and narrow body", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(campaignBody(), 201));
    const input = {
      type: "public_giveaway",
      title: "Neighborhood cleanup reward",
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    } as const;
    const result = await createCampaign({ ...input });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(result).toEqual({ kind: "created", campaign: campaignBody().campaign });
  });

  it("updates drafts with the campaign-scoped PATCH contract", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(campaignBody()));
    const result = await updateCampaign(CAMPAIGN, { title: "Renamed reward" });

    expect(mocks.fetch).toHaveBeenCalledWith(`/api/campaigns/${CAMPAIGN}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed reward" }),
    });
    expect(result).toEqual({ kind: "updated", campaign: campaignBody().campaign });
  });

  it("reads funding readiness over GET with no body", async () => {
    const readiness = { ready: false, settlementStatus: "configured" };
    mocks.fetch.mockResolvedValue(jsonResponse({ campaign: campaignBody().campaign, fundingReadiness: readiness }));
    const result = await getCampaignFundingReadiness(CAMPAIGN);

    expect(mocks.fetch).toHaveBeenCalledWith(`/api/campaigns/${CAMPAIGN}/funding-readiness`);
    expect(result).toEqual({
      kind: "loaded",
      campaign: campaignBody().campaign,
      fundingReadiness: readiness,
    });
  });

  it("drives the funding intent lifecycle with canonical payloads", async () => {
    const intent = {
      fundingIntentId: INTENT,
      campaignId: CAMPAIGN,
      reference: "votum:fund:abc",
      vaultAddressHex: "01" + "c".repeat(38),
      requiredFundingLuna: "580000",
      submittedTransactionHash: null,
    };
    mocks.fetch.mockResolvedValue(jsonResponse({ fundingIntent: intent, resultKind: "created" }, 201));
    const created = await createCampaignFundingIntent(CAMPAIGN);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/funding/intents`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(created).toEqual({ kind: "created", fundingIntent: intent });

    const hash = "ab".repeat(32);
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ binding: { transactionHash: hash }, resultKind: "bound" }, 201));
    const bound = await bindCampaignFunding(CAMPAIGN, INTENT, hash);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/funding/intents/${INTENT}/bind`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ transactionHash: hash }),
      }),
    );
    expect(bound).toEqual({
      kind: "bound",
      binding: { transactionHash: hash },
    });

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ confirmation: { kind: "confirmed" } }));
    const confirmed = await confirmCampaignFunding(CAMPAIGN, INTENT);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/funding/intents/${INTENT}/confirm`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(confirmed).toEqual({ kind: "confirmed", confirmation: { kind: "confirmed" } });
  });

  it("publishes and closes with session-derived identity only", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(campaignBody()));
    const published = await publishCampaign(CAMPAIGN);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/publish`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(published).toEqual({ kind: "published", campaign: campaignBody().campaign });

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ settlementId: "settlement-1", closed: true }));
    const closed = await closeCampaign(CAMPAIGN);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/close`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(closed).toEqual({ kind: "closed", settlementId: "settlement-1" });

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ settlementId: "settlement-1", closed: true }));
    const replay = await closeCampaign(CAMPAIGN);
    expect(replay).toEqual({ kind: "closed", settlementId: "settlement-1" });
  });

  it("reads the public projection over GET", async () => {
    const dto = { campaignId: CAMPAIGN, claimState: "open", remainingRewards: 7 };
    mocks.fetch.mockResolvedValue(jsonResponse(dto));
    const result = await getPublicCampaign(CAMPAIGN);
    expect(mocks.fetch).toHaveBeenCalledWith(`/api/campaigns/${CAMPAIGN}/public`);
    expect(result).toEqual({ kind: "loaded", campaign: dto });
  });
});

describe("creator-client error model", () => {
  it("preserves server error codes with HTTP status", async () => {
    for (const [status, body, code] of [
      [401, { error: "session_missing" }, "session_missing"],
      [403, { error: "forbidden" }, "forbidden"],
      [404, { error: "campaign_not_found" }, "campaign_not_found"],
      [409, { error: "immutable" }, "immutable"],
      [409, { error: "campaign_state_conflict" }, "campaign_state_conflict"],
      [422, { error: "invalid_request" }, "invalid_request"],
      [422, { error: "claim_not_available", reasonCode: "funding_pending" }, "funding_pending"],
    ] as const) {
      mocks.fetch.mockReset();
      mocks.fetch.mockResolvedValue(jsonResponse(body, status));
      const result = await getCampaignFundingReadiness(CAMPAIGN);
      expect(result, JSON.stringify(body)).toEqual({
        kind: "error",
        error: { code, status },
      });
    }
  });

  it("falls back safely on malformed and network failures", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("no json"); } });
    await expect(getPublicCampaign(CAMPAIGN)).resolves.toEqual({
      kind: "error",
      error: { code: "request_failed", status: 500 },
    });

    mocks.fetch.mockReset();
    mocks.fetch.mockRejectedValue(new Error("network down"));
    await expect(getPublicCampaign(CAMPAIGN)).resolves.toEqual({
      kind: "error",
      error: { code: "request_failed", status: 0 },
    });
  });

  it("exposes no secret, wallet-identity, or authority surface", async () => {
    const client = await import("@/lib/campaigns/creator-client");
    for (const forbidden of ["secret", "privateKey", "service_role", "ownerWallet", "settlementId", "vault"]) {
      expect(
        Object.keys(client).some((key) => key.toLowerCase().includes(forbidden.toLowerCase())),
        forbidden,
      ).toBe(false);
    }
    expect(typeof (client as Record<string, unknown>).createCampaign).toBe("function");
    // The creator refund surface is intentionally exposed (C5 owns it).
    expect(typeof (client as Record<string, unknown>).refundCampaign).toBe("function");
  });

  it("refunds over POST with no body authority and preserves terminal results", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      refundId: "refund-1",
      status: "broadcasted",
      transactionHash: "ab".repeat(32),
      preparationKind: "created",
    }));
    const processed = await refundCampaign(CAMPAIGN);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/campaigns/${CAMPAIGN}/refund`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.fetch.mock.calls[0][1]).not.toHaveProperty("body");
    expect(processed).toEqual({
      kind: "processed",
      refundId: "refund-1",
      status: "broadcasted",
      transactionHash: "ab".repeat(32),
    });

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ status: "refunded", resultKind: "nothing_to_refund" }));
    await expect(refundCampaign(CAMPAIGN)).resolves.toEqual({ kind: "refunded" });

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "unresolved_reward_obligations" }, 409));
    await expect(refundCampaign(CAMPAIGN)).resolves.toEqual({
      kind: "error",
      error: { code: "unresolved_reward_obligations", status: 409 },
    });
  });
});
