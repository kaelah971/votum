import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const OTHER = "01" + "b".repeat(38);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  admin: { marker: "admin" },
  read: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin,
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/public-giveaway", () => ({
  getOwnCampaignClaim: (...args: unknown[]) => mocks.read(...args),
}));

import { GET } from "@/app/api/campaigns/[campaignId]/claims/mine/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.read.mockReset();
  mocks.read.mockResolvedValue({ claimed: false });
});

describe("GET /api/campaigns/[campaignId]/claims/mine", () => {
  it("requires a verified wallet session", async () => {
    mocks.session = null;
    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns not-claimed without distinguishing empty from foreign claims", async () => {
    const mine = await GET(new Request("http://localhost"), context());
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ claimed: false });
    expect(mocks.read).toHaveBeenCalledWith(mocks.admin, "campaign-1", OWNER);

    mocks.session = { address: OTHER };
    const foreign = await GET(new Request("http://localhost"), context());
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ claimed: false });
    expect(mocks.read).toHaveBeenCalledWith(mocks.admin, "campaign-1", OTHER);
  });

  it("scopes reads to the session wallet and reveals nothing else", async () => {
    mocks.read.mockResolvedValue({
      claimed: true,
      status: "reserved",
      receiptId: "receipt-1",
      paidAt: null,
      transactionHash: null,
    });
    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      claimed: true,
      status: "reserved",
      receiptId: "receipt-1",
      paidAt: null,
      transactionHash: null,
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of ["participant_wallet", "nonce", "ciphertext", "vault", "challenge"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns 404 for unresolvable Campaigns", async () => {
    mocks.read.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), context("missing"));

    expect(response.status).toBe(404);
  });
});
