import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/campaigns/[campaignId]/refund/route";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT = "33333333-3333-4333-8333-333333333333";
const REFUND = "44444444-4444-4434-8444-444444444444";
const OWNER = "01" + "a".repeat(38);
const TOKEN_HASH = "b".repeat(64);
const HASH = "ab".repeat(32);

const mocks = vi.hoisted(() => ({
  session: null as { address: string; tokenHash: string } | null,
  admin: { marker: "admin" },
  adminConfigured: true,
  prepare: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => Promise.resolve(mocks.session),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (mocks.adminConfigured ? mocks.admin : null),
  getAdminConfigStatus: () => ({ configured: mocks.adminConfigured }),
}));

vi.mock("@/lib/campaigns/refund", () => ({
  prepareCampaignRefund: mocks.prepare,
  executeCampaignRefund: mocks.execute,
}));

function post(body?: unknown): Request {
  return new Request(`http://localhost/api/campaigns/${CAMPAIGN}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = Promise.resolve({ campaignId: CAMPAIGN });

function ownerSession() {
  mocks.session = { address: OWNER, tokenHash: TOKEN_HASH };
}

beforeEach(() => {
  mocks.session = null;
  mocks.adminConfigured = true;
  mocks.prepare.mockReset();
  mocks.execute.mockReset();
});

describe("POST /api/campaigns/[campaignId]/refund — auth", () => {
  it("rejects missing sessions with 401", async () => {
    const response = await POST(post(), { params });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "session_missing" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("maps owner mismatch to 403", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "error", reasonCode: "forbidden" });
    const response = await POST(post(), { params });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps unknown campaigns to 404", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "error", reasonCode: "campaign_not_found" });
    const response = await POST(post(), { params });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "campaign_not_found" });
  });
});

describe("POST /api/campaigns/[campaignId]/refund — authority", () => {
  it("derives everything server-side and ignores forged financial bodies", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "created", settlementId: SETTLEMENT, refundId: REFUND });
    mocks.execute.mockResolvedValue({ kind: "broadcasted", refundId: REFUND, transactionHash: HASH });

    const forged = {
      settlementId: "forged",
      refundId: "forged",
      amount: "999999",
      amountLuna: "999999",
      recipient: "forged",
      vault: "forged",
      wallet: "forged",
      feeLuna: "1",
    };
    const response = await POST(post(forged), { params });

    expect(response.status).toBe(200);
    // Identity-only handoff: campaign, owner, and session token.
    expect(mocks.prepare).toHaveBeenCalledWith(mocks.admin, CAMPAIGN, OWNER, TOKEN_HASH);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.refundId).toBe(REFUND);
    expect(body.status).toBe("broadcasted");
  });

  it("accepts an empty body", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "created", settlementId: SETTLEMENT, refundId: REFUND });
    mocks.execute.mockResolvedValue({ kind: "already_pending", refundId: REFUND, transactionHash: null });

    const response = await POST(post(), { params });
    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/campaigns/[campaignId]/refund — lifecycle", () => {
  it("blocks unresolved obligations and reconciliation with 409", async () => {
    ownerSession();
    for (const reasonCode of ["unresolved_reward_obligations", "payout_reconciliation_required"]) {
      mocks.prepare.mockReset();
      mocks.execute.mockReset();
      mocks.prepare.mockResolvedValue({ kind: "error", reasonCode });
      const response = await POST(post(), { params });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: reasonCode });
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  });

  it("blocks unclosable lifecycles with 409", async () => {
    ownerSession();
    for (const reasonCode of ["campaign_not_closable", "participation_window_open"]) {
      mocks.prepare.mockReset();
      mocks.prepare.mockResolvedValue({ kind: "error", reasonCode });
      const response = await POST(post(), { params });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: reasonCode });
    }
  });

  it("returns safe terminal results without executing", async () => {
    ownerSession();
    for (const kind of ["nothing_to_refund", "already_refunded_or_closed"]) {
      mocks.prepare.mockReset();
      mocks.execute.mockReset();
      mocks.prepare.mockResolvedValue({ kind, settlementId: SETTLEMENT });
      const response = await POST(post(), { params });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "refunded", resultKind: kind });
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  });

  it("reuses the same refund intent on replay with a single execution", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "replay", settlementId: SETTLEMENT, refundId: REFUND });
    mocks.execute.mockResolvedValue({ kind: "already_pending", refundId: REFUND, transactionHash: null });

    const response = await POST(post(), { params });
    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith(mocks.admin, SETTLEMENT, REFUND);
    expect(await response.json()).toMatchObject({
      refundId: REFUND,
      status: "already_pending",
      preparationKind: "replay",
    });
  });

  it("maps retryable execution to 503 without a second preparation", async () => {
    ownerSession();
    mocks.prepare.mockResolvedValue({ kind: "created", settlementId: SETTLEMENT, refundId: REFUND });
    mocks.execute.mockResolvedValue({ kind: "retryable", refundId: REFUND, reasonCode: "injected" });

    const response = await POST(post(), { params });
    expect(response.status).toBe(503);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
