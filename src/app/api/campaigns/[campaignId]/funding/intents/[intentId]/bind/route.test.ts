import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const HASH = "ab".repeat(32);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  admin: { marker: "admin" },
  bind: vi.fn(),
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
  bindCampaignFunding: (...args: unknown[]) => mocks.bind(...args),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/funding/intents/[intentId]/bind/route";

function context(campaignId = "campaign-1", intentId = "intent-1") {
  return { params: Promise.resolve({ campaignId, intentId }) };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.sameOrigin = true;
  mocks.bind.mockReset();
  mocks.bind.mockResolvedValue({
    kind: "bound",
    settlementId: "settlement-1",
    intentId: "intent-1",
    transactionHash: HASH,
  });
});

describe("POST /api/campaigns/[campaignId]/funding/intents/[intentId]/bind", () => {
  it("rejects cross-origin requests before any funding work", async () => {
    mocks.sameOrigin = false;
    const response = await POST(request({ transactionHash: HASH }), context());

    expect(response.status).toBe(403);
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("requires a verified wallet session", async () => {
    mocks.session = null;
    const response = await POST(request({ transactionHash: HASH }), context());

    expect(response.status).toBe(401);
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("rejects malformed hashes without touching the engine", async () => {
    const response = await POST(request({ transactionHash: "not-a-hash" }), context());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_hash");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("binds with settlement identity and ignores spoofed fields", async () => {
    const response = await POST(
      request({ transactionHash: HASH.toUpperCase(), amount_luna: "1", vault: "xx", campaignId: "forged" }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
    expect(mocks.bind).toHaveBeenCalledWith(mocks.admin, "campaign-1", "intent-1", OWNER, HASH);
    const body = await response.json();
    expect(body.binding).toMatchObject({
      fundingIntentId: "intent-1",
      campaignId: "settlement-1",
      transactionHash: HASH,
      status: "submitted",
    });
    expect(body.resultKind).toBe("bound");
  });

  it("maps engine rejections to typed statuses", async () => {
    mocks.bind.mockResolvedValue({ kind: "error", reasonCode: "forbidden" });
    await expect(
      POST(request({ transactionHash: HASH }), context()).then((r) => r.status),
    ).resolves.toBe(403);

    mocks.bind.mockResolvedValue({ kind: "error", reasonCode: "intent_not_found" });
    await expect(
      POST(request({ transactionHash: HASH }), context()).then((r) => r.status),
    ).resolves.toBe(404);

    mocks.bind.mockResolvedValue({ kind: "error", reasonCode: "transaction_already_reserved" });
    const reused = await POST(request({ transactionHash: HASH }), context());
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe("transaction_already_reserved");
  });
});
