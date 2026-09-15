import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  publish: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/campaigns/configuration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns/configuration")>()),
  publishParticipationCampaign: mocks.publish,
}));

import { POST } from "@/app/api/campaigns/[campaignId]/publish/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.publish.mockReset();
  mocks.publish.mockResolvedValue({ campaign: { campaignId: "campaign-1", status: "published" } });
});

describe("POST /api/campaigns/[campaignId]/publish", () => {
  it("requires a verified session", async () => {
    mocks.session = null;
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(401);
  });

  it("maps unsupported strategy readiness to a truthful conflict", async () => {
    mocks.publish.mockRejectedValue({ code: "not_publishable", message: "This Campaign type is not publishable yet." });
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("claimable");
  });

  it("publishes product configuration without advertising funding or claims", async () => {
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(OWNER, "campaign-1");
    const body = await response.json();
    expect(body.campaign.status).toBe("published");
    expect(JSON.stringify(body)).not.toContain("claimable");
    expect(JSON.stringify(body)).not.toContain("funded");
  });
});
