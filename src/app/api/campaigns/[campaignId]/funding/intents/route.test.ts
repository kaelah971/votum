import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const OTHER = "01" + "b".repeat(38);
const VAULT = "01" + "c".repeat(38);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  admin: { marker: "admin" },
  begin: vi.fn(),
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

vi.mock("@/lib/campaigns/funding", () => ({
  beginCampaignFunding: (...args: unknown[]) => mocks.begin(...args),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/funding/intents/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

function request(body: unknown, origin?: string): Request {
  return new Request("http://localhost/api/campaigns/campaign-1/funding/intents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function intentResult() {
  return {
    kind: "created" as const,
    fundingIntent: {
      fundingIntentId: "intent-1",
      campaignId: "campaign-1",
      reference: "votum:fund:abc",
      memo: "votum:fund:abc",
      vaultAddressHex: VAULT,
      vaultAddressNq: "NQ...",
      rewardPrincipalLuna: "500000",
      feeReserveLuna: "80000",
      requiredFundingLuna: "580000",
      requiredFundingNim: "5.8",
      submittedTransactionHash: null,
      confirmationDeadline: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  };
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.sameOrigin = true;
  mocks.begin.mockReset();
  mocks.begin.mockResolvedValue(intentResult());
});

describe("POST /api/campaigns/[campaignId]/funding/intents", () => {
  it("rejects cross-origin requests before any funding work", async () => {
    mocks.sameOrigin = false;
    const response = await POST(request({}, "https://evil.example"), context());

    expect(response.status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("requires a verified wallet session", async () => {
    mocks.session = null;
    const response = await POST(request({}), context());

    expect(response.status).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects non-owner funders with 403", async () => {
    mocks.begin.mockResolvedValue({ kind: "error", reasonCode: "forbidden" });
    const response = await POST(request({}), context());

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("forbidden");
  });

  it("returns 404 for unknown Campaigns", async () => {
    mocks.begin.mockResolvedValue({ kind: "error", reasonCode: "campaign_not_found" });
    const response = await POST(request({}), context("missing"));

    expect(response.status).toBe(404);
  });

  it("returns the server-derived intent and ignores spoofed economics", async () => {
    const response = await POST(
      request({
        amount_luna: "999999999",
        totalBudget: "1",
        vault: "00" + "f".repeat(38),
        refund_recipient: OTHER,
        ownerWallet: OTHER,
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.begin).toHaveBeenCalledWith(mocks.admin, "campaign-1", OWNER);
    const body = await response.json();
    expect(body.fundingIntent.requiredFundingLuna).toBe("580000");
    expect(body.fundingIntent.vaultAddressHex).toBe(VAULT);
    expect(body.campaignState).toBe("funding_pending");
    expect(body.resultKind).toBe("created");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(OTHER);
  });
});
