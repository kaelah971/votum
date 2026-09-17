import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const PARTICIPANT = "01" + "b".repeat(38);

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "b".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  adminTables: {} as Record<string, Row[]>,
  projector: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", () => ({
  isSameOriginRequest: () => mocks.sameOrigin,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return api;
        },
        maybeSingle: async () => {
          const rows = (mocks.adminTables[table] ?? []).filter((row) =>
            filters.every(([col, val]) => row[col] === val),
          );
          return { data: rows[0] ?? null, error: null };
        },
      };
      return api;
    },
  }),
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/public-giveaway", () => ({
  getPublicCampaignGiveaway: (...args: unknown[]) => mocks.projector(...args),
}));

vi.mock("@/lib/campaigns/claim-challenge", () => ({
  CampaignClaimChallengeError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  issueCampaignClaimChallenge: (...args: unknown[]) => mocks.issue(...args),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/claims/challenge/route";

function context(campaignId = "campaign-1") {
  return { params: Promise.resolve({ campaignId }) };
}

function campaignRow(overrides: Row = {}): Row {
  return {
    id: "campaign-1",
    campaign_type: "public_giveaway",
    visibility: "public",
    status: "published",
    owner_wallet: OWNER,
    ...overrides,
  };
}

function openProjection() {
  return {
    campaignId: "campaign-1",
    campaignType: "public_giveaway",
    claimState: "open",
    published: true,
    fundingReady: true,
  };
}

beforeEach(() => {
  mocks.session = { address: PARTICIPANT };
  mocks.sameOrigin = true;
  mocks.adminTables = { participation_campaigns: [campaignRow()] };
  mocks.projector.mockReset();
  mocks.projector.mockResolvedValue(openProjection());
  mocks.issue.mockReset();
  mocks.issue.mockResolvedValue({
    challengeId: "challenge-1",
    message: "sign this",
    expiresAt: "2026-09-16T12:05:00.000Z",
  });
});

describe("POST /api/campaigns/[campaignId]/claims/challenge", () => {
  it("requires a verified session and same origin", async () => {
    mocks.session = null;
    const unauthenticated = await POST(new Request("http://localhost"), context());
    expect(unauthenticated.status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();

    mocks.session = { address: PARTICIPANT };
    mocks.sameOrigin = false;
    const foreign = await POST(
      new Request("http://localhost", { headers: { origin: "https://evil.example" } }),
      context(),
    );
    expect(foreign.status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown Campaigns", async () => {
    mocks.adminTables = { participation_campaigns: [] };
    const response = await POST(new Request("http://localhost"), context("missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "campaign_not_found" });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", "public", "not_published"],
    ["cancelled", "public", "not_published"],
    ["published", "private", "not_published"],
  ])("rejects %s/%s Campaigns as not published", async (status, visibility, reasonCode) => {
    mocks.adminTables = { participation_campaigns: [campaignRow({ status, visibility })] };
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "claim_not_available", reasonCode });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("rejects unsupported Campaign types", async () => {
    for (const type of ["secret_drop", "private_drop", "event_drop", "community_reward"]) {
      mocks.adminTables = { participation_campaigns: [campaignRow({ campaign_type: type })] };
      const response = await POST(new Request("http://localhost"), context());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "claim_not_available",
        reasonCode: "unsupported_type",
      });
    }
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("rejects creator self-claim authorization", async () => {
    mocks.session = { address: OWNER };
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "claim_not_available",
      reasonCode: "creator_ineligible",
    });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["needs_funding", "funding_pending"],
    ["starts_soon", "not_started"],
    ["ended", "ended"],
    ["closed", "closed"],
  ])("rejects %s Campaigns without issuing", async (claimState, reasonCode) => {
    mocks.projector.mockResolvedValue({ ...openProjection(), claimState, fundingReady: false });
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "claim_not_available", reasonCode });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("issues exactly the signing payload for open Campaigns", async () => {
    const response = await POST(new Request("http://localhost"), context());

    expect(response.status).toBe(201);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.issue).toHaveBeenCalledWith(expect.anything(), {
      campaignId: "campaign-1",
      sessionAddress: PARTICIPANT,
    });
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["challengeId", "expiresAt", "message"]);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["nonce_hash", "consumed", "settlement", "vault", "receipt", "token"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
