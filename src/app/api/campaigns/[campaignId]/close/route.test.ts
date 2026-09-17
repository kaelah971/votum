import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  admin: { marker: "admin" },
  close: vi.fn(),
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

vi.mock("@/lib/campaigns/close", () => ({
  closeParticipationCampaign: (...args: unknown[]) => mocks.close(...args),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/close/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

function request(body: unknown = {}): Request {
  return new Request("http://localhost/api/campaigns/campaign-1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.sameOrigin = true;
  mocks.close.mockReset();
  mocks.close.mockResolvedValue({ kind: "closed", settlementId: SETTLEMENT });
});

describe("POST /api/campaigns/[campaignId]/close", () => {
  it("rejects cross-origin requests and missing sessions before any close work", async () => {
    mocks.sameOrigin = false;
    const origin = await POST(request(), context());
    expect(origin.status).toBe(403);
    expect((await origin.json()).error).toBe("invalid_origin");

    mocks.sameOrigin = true;
    mocks.session = null;
    const session = await POST(request(), context());
    expect(session.status).toBe(401);
    expect((await session.json()).error).toBe("session_missing");
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("closes with server-derived identity and ignores body economics", async () => {
    const response = await POST(
      request({ ownerWallet: "forged", settlementId: "forged", close_reason: "forged" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settlementId: SETTLEMENT, closed: true });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledWith(mocks.admin, "campaign-1", OWNER);
  });

  it("replays an already-closed Campaign idempotently", async () => {
    mocks.close.mockResolvedValue({ kind: "replay", settlementId: SETTLEMENT });
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settlementId: SETTLEMENT, closed: true });
  });

  it("maps close rejections onto typed statuses", async () => {
    mocks.close.mockResolvedValue({ kind: "error", reasonCode: "forbidden" });
    const forbidden = await POST(request(), context());
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe("forbidden");

    mocks.close.mockResolvedValue({ kind: "error", reasonCode: "campaign_not_found" });
    const missing = await POST(request(), context());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("campaign_not_found");

    mocks.close.mockResolvedValue({ kind: "error", reasonCode: "invalid_state" });
    const conflict = await POST(request(), context());
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("invalid_state");
  });
});
