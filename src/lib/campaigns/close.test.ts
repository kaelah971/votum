import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeParticipationCampaign } from "@/lib/campaigns/close";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";
const OWNER = "01" + "a".repeat(38);
const OTHER = "02" + "b".repeat(38);

type Row = Record<string, unknown>;

interface FakeDb {
  campaign: Row | null;
  binding: Row | null;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  rpcImpl: () => unknown;
}

function baseTables(): { campaigns: Row[]; bindings: Row[] } {
  return {
    campaigns: [{
      id: CAMPAIGN,
      settlement_id: SETTLEMENT,
      owner_wallet: OWNER,
    }],
    bindings: [{
      settlement_id: SETTLEMENT,
      source_type: "participation_campaign",
      participation_campaign_id: CAMPAIGN,
    }],
  };
}

function makeAdmin(db: FakeDb & { tables: { campaigns: Row[]; bindings: Row[] } }) {
  return {
    from: (table: string) => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => {
          if (table === "participation_campaigns") {
            const row = db.tables.campaigns.find((item) => item.id === CAMPAIGN) ?? null;
            return { data: row, error: null };
          }
          const row = db.tables.bindings.find((item) => item.participation_campaign_id === CAMPAIGN) ?? null;
          return { data: row, error: null };
        },
      };
      return api;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return db.rpcImpl();
    },
  };
}

function dbWith(rpcImpl: () => unknown): FakeDb & { tables: { campaigns: Row[]; bindings: Row[] } } {
  return { campaign: null, binding: null, tables: baseTables(), rpcCalls: [], rpcImpl };
}

function closedResult() {
  return () => ({ data: { result_kind: "closed", campaign_id: CAMPAIGN, settlement_id: SETTLEMENT }, error: null });
}

describe("closeParticipationCampaign", () => {
  it("closes an owned Campaign through the atomic RPC with canonical identity", async () => {
    const db = dbWith(closedResult());
    const result = await closeParticipationCampaign(makeAdmin(db) as never, CAMPAIGN, OWNER.toUpperCase());

    expect(result).toEqual({ kind: "closed", settlementId: SETTLEMENT });
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toEqual({
      fn: "close_participation_campaign_atomic",
      args: { _campaign_id: CAMPAIGN, _owner_wallet: OWNER },
    });
  });

  it("replays an already-closed Campaign without failing", async () => {
    const db = dbWith(() => ({
      data: { result_kind: "replay", campaign_id: CAMPAIGN, settlement_id: SETTLEMENT },
      error: null,
    }));
    await expect(
      closeParticipationCampaign(makeAdmin(db) as never, CAMPAIGN, OWNER),
    ).resolves.toEqual({ kind: "replay", settlementId: SETTLEMENT });
  });

  it("maps deterministic RPC rejections without touching the mutation", async () => {
    for (const [resultKind, reasonCode] of [
      ["campaign_not_found", "campaign_not_found"],
      ["forbidden", "forbidden"],
      ["invalid_state", "invalid_state"],
    ] as const) {
      const db = dbWith(() => ({ data: { result_kind: resultKind }, error: null }));
      await expect(
        closeParticipationCampaign(makeAdmin(db) as never, CAMPAIGN, OWNER),
        resultKind,
      ).resolves.toEqual({ kind: "error", reasonCode });
    }
  });

  it("rejects non-owners and malformed wallets before any RPC call", async () => {
    const stranger = dbWith(closedResult());
    await expect(
      closeParticipationCampaign(makeAdmin(stranger) as never, CAMPAIGN, OTHER),
    ).resolves.toEqual({ kind: "error", reasonCode: "forbidden" });
    expect(stranger.rpcCalls).toEqual([]);

    const malformed = dbWith(closedResult());
    await expect(
      closeParticipationCampaign(makeAdmin(malformed) as never, CAMPAIGN, "not-a-wallet"),
    ).resolves.toEqual({ kind: "error", reasonCode: "forbidden" });
    expect(malformed.rpcCalls).toEqual([]);
  });

  it("rejects unknown Campaigns during resolution without RPC", async () => {
    const db = dbWith(closedResult());
    db.tables.campaigns = [];
    await expect(
      closeParticipationCampaign(makeAdmin(db) as never, CAMPAIGN, OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "campaign_not_found" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("fails closed on transport faults and malformed RPC results", async () => {
    const fault = dbWith(() => { throw new Error("db down"); });
    await expect(
      closeParticipationCampaign(makeAdmin(fault) as never, CAMPAIGN, OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "service_unavailable" });

    const malformed = dbWith(() => ({ data: { result_kind: "closed" }, error: null }));
    await expect(
      closeParticipationCampaign(makeAdmin(malformed) as never, CAMPAIGN, OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "service_unavailable" });
  });

  it("performs no product, settlement, refund, or payout writes in the service layer", () => {
    // Owner pre-check reads (campaign + binding rows) mirror funding.ts and
    // are allowed; the atomic RPC owns every write.
    const serviceSource = readFileSync(resolve(process.cwd(), "src/lib/campaigns/close.ts"), "utf8");
    expect(serviceSource).not.toMatch(/\.update\(/);
    expect(serviceSource).not.toMatch(/\.insert\(/);
    expect(serviceSource).not.toMatch(/\.delete\(/);
    expect(serviceSource).not.toMatch(/\.upsert\(/);
    expect(serviceSource).not.toContain('from("reward_refunds")');
    expect(serviceSource).not.toContain("executePayout");
    expect(serviceSource).not.toContain("executeRewardRefund");
    expect(serviceSource).not.toContain("refundable");
  });
});
