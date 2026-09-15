import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  readiness: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/campaigns/configuration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns/configuration")>()),
  loadCampaignFundingReadiness: mocks.readiness,
}));

import { GET } from "@/app/api/campaigns/[campaignId]/funding-readiness/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.readiness.mockReset();
  mocks.readiness.mockResolvedValue({
    campaign: { campaignId: "campaign-1", status: "published" },
    fundingReadiness: { ready: false, reason: "vault_not_ready" },
  });
});

describe("GET /api/campaigns/[campaignId]/funding-readiness", () => {
  it("requires a verified session", async () => {
    mocks.session = null;
    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(401);
  });

  it("returns safe pre-E readiness without claimability or private vault fields", async () => {
    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    expect(mocks.readiness).toHaveBeenCalledWith(OWNER, "campaign-1");
    const body = await response.json();
    expect(body.fundingReadiness).toEqual({ ready: false, reason: "vault_not_ready" });
    expect(JSON.stringify(body)).not.toContain("claimable");
    expect(JSON.stringify(body)).not.toContain("ciphertext");
    expect(JSON.stringify(body)).not.toContain("key");
  });
});
