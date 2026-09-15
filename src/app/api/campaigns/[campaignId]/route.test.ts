import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  update: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/campaigns/configuration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns/configuration")>()),
  updateParticipationCampaignDraft: mocks.update,
}));

import { PATCH } from "@/app/api/campaigns/[campaignId]/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/campaigns/campaign-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({ campaign: { campaignId: "campaign-1", status: "draft" } });
});

describe("PATCH /api/campaigns/[campaignId]", () => {
  it("requires a verified session", async () => {
    mocks.session = null;
    const response = await PATCH(request({ title: "Nope" }), context());

    expect(response.status).toBe(401);
  });

  it("maps a non-owner failure to 403", async () => {
    mocks.update.mockRejectedValue({ code: "forbidden", message: "Only the Campaign owner may edit it." });
    const response = await PATCH(request({ title: "Nope" }), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });

  it("updates only through the authoritative Campaign boundary", async () => {
    const response = await PATCH(request({ title: "Updated campaign", rewardPerParticipant: "1" }), context());

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(OWNER, "campaign-1", expect.any(Object));
  });
});
