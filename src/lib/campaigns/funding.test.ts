import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);
const OTHER = "01" + "b".repeat(38);
const SETTLEMENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const VAULT = "01" + "c".repeat(38);

const mocks = vi.hoisted(() => ({
  vaultRow: null as { vaultAddressHex: string } | null,
}));

vi.mock("@/lib/rewards/vault-service", () => ({
  getRewardSettlementVault: async () =>
    mocks.vaultRow ? { settlementId: SETTLEMENT, campaignId: null, vaultAddressHex: VAULT, vaultAddressNq: "NQ...", created: false } : null,
}));

import {
  beginCampaignFunding,
  bindCampaignFunding,
  confirmCampaignFunding,
} from "@/lib/campaigns/funding";
import { resolveCampaignRewardSettlement } from "@/lib/campaigns/settlement";

type Row = Record<string, unknown>;

function settlementRow(overrides: Row = {}): Row {
  return {
    id: SETTLEMENT,
    owner_wallet: OWNER,
    funding_wallet: OWNER,
    refund_recipient_wallet: OWNER,
    funding_mode: "creator",
    asset: "NIM",
    reward_per_participant_luna: 50000,
    max_rewarded_participants: 10,
    reward_principal_luna: 500000,
    fee_reserve_luna: 80000,
    total_budget_luna: 580000,
    status: "configured",
    funded_amount_luna: 0,
    refundable_excess_luna: 0,
    rewarded_participant_count: 0,
    paid_amount_luna: 0,
    fee_spent_luna: 0,
    refundable_amount_luna: 0,
    first_reservation_at: null,
    payout_lock_attempt_id: null,
    payout_lock_expires_at: null,
    payout_lock_token: null,
    created_at: new Date().toISOString(),
    funded_at: null,
    closed_at: null,
    refunded_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function campaignRow(overrides: Row = {}): Row {
  return { id: CAMPAIGN, settlement_id: SETTLEMENT, owner_wallet: OWNER, ...overrides };
}

function bindingRow(overrides: Row = {}): Row {
  return {
    settlement_id: SETTLEMENT,
    source_type: "participation_campaign",
    participation_campaign_id: CAMPAIGN,
    reward_campaign_id: null,
    ...overrides,
  };
}

interface FakeDb {
  tables: Record<string, Row[]>;
  rpcCalls: Array<{ fn: string; args: Row }>;
  rpcImpl: (fn: string, args: Row) => unknown;
}

function makeAdmin(db: FakeDb) {
  const chain = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      maybeSingle: async () => {
        const rows = (db.tables[table] ?? []).filter((row) =>
          filters.every(([col, val]) => row[col] === val),
        );
        return { data: rows[0] ?? null, error: null };
      },
    };
    return api;
  };
  return {
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: Row) => {
      db.rpcCalls.push({ fn, args });
      return { data: db.rpcImpl(fn, args), error: null };
    },
  };
}

function beginRpcResult() {
  return {
    result_kind: "created",
    intent_id: INTENT,
    campaign_id: CAMPAIGN,
    settlement_id: SETTLEMENT,
    reference: "votum:fund:abc123",
    vault_wallet: VAULT,
    reward_principal_luna: "500000",
    fee_reserve_luna: "80000",
    amount_luna: "580000",
    submitted_transaction_hash: null,
    confirmation_deadline: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

function baseTables(): Record<string, Row[]> {
  return {
    participation_campaigns: [campaignRow()],
    settlement_source_bindings: [bindingRow()],
    reward_settlements: [settlementRow()],
    reward_funding_transactions: [],
    reward_campaign_vaults: [],
  };
}

beforeEach(() => {
  mocks.vaultRow = { vaultAddressHex: VAULT };
});

describe("resolveCampaignRewardSettlement", () => {
  it("resolves the Campaign branch to the settlement with the canonical owner", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await resolveCampaignRewardSettlement(makeAdmin(db) as never, CAMPAIGN);
    expect(result).toMatchObject({
      kind: "ok",
      settlementId: SETTLEMENT,
      participationCampaignId: CAMPAIGN,
      sourceType: "participation_campaign",
      ownerWallet: OWNER,
    });
  });

  it("returns not_found for an unknown Campaign", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await resolveCampaignRewardSettlement(makeAdmin(db) as never, "nope");
    expect(result).toMatchObject({ kind: "not_found", reasonCode: "settlement_not_found" });
  });

  it("fails closed on binding mismatch and owner mismatch", async () => {
    const wrongBinding: FakeDb = {
      tables: { ...baseTables(), settlement_source_bindings: [bindingRow({ settlement_id: "other" })] },
      rpcCalls: [],
      rpcImpl: () => ({}),
    };
    await expect(
      resolveCampaignRewardSettlement(makeAdmin(wrongBinding) as never, CAMPAIGN),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "malformed_settlement_binding" });

    const wrongOwner: FakeDb = {
      tables: { ...baseTables(), participation_campaigns: [campaignRow({ owner_wallet: OTHER })] },
      rpcCalls: [],
      rpcImpl: () => ({}),
    };
    await expect(
      resolveCampaignRewardSettlement(makeAdmin(wrongOwner) as never, CAMPAIGN),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "malformed_settlement_binding" });
  });
});

describe("beginCampaignFunding", () => {
  it("rejects unknown Campaigns without touching the engine", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await beginCampaignFunding(makeAdmin(db) as never, "nope", OWNER);
    expect(result).toMatchObject({ kind: "error", reasonCode: "campaign_not_found" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects non-owner funders and malformed wallets without touching the engine", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const admin = makeAdmin(db) as never;
    await expect(beginCampaignFunding(admin, CAMPAIGN, OTHER)).resolves.toMatchObject({
      kind: "error",
      reasonCode: "forbidden",
    });
    await expect(beginCampaignFunding(admin, CAMPAIGN, "not-a-wallet")).resolves.toMatchObject({
      kind: "error",
      reasonCode: "forbidden",
    });
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects non-creator funding modes", async () => {
    const db: FakeDb = {
      tables: {
        ...baseTables(),
        reward_settlements: [settlementRow({ funding_mode: "community", funding_wallet: OTHER })],
      },
      rpcCalls: [],
      rpcImpl: () => ({}),
    };
    const result = await beginCampaignFunding(makeAdmin(db) as never, CAMPAIGN, OWNER);
    expect(result).toMatchObject({ kind: "error", reasonCode: "forbidden" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects a missing vault without touching the engine", async () => {
    mocks.vaultRow = null;
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await beginCampaignFunding(makeAdmin(db) as never, CAMPAIGN, OWNER);
    expect(result).toMatchObject({ kind: "error", reasonCode: "vault_unavailable" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("delegates with the settlement ID and returns the server-derived amount", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => beginRpcResult() };
    const result = await beginCampaignFunding(makeAdmin(db) as never, CAMPAIGN, OWNER.toUpperCase());
    expect(result.kind).toBe("created");
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toMatchObject({
      fn: "begin_reward_funding_atomic",
      args: { _settlement_id: SETTLEMENT, _funder_wallet: OWNER },
    });
    if (result.kind === "created") {
      expect(result.fundingIntent.requiredFundingLuna).toBe("580000");
      expect(result.fundingIntent.vaultAddressHex).toBe(VAULT);
    } else {
      throw new Error("expected created funding intent");
    }
  });
});

describe("bindCampaignFunding", () => {
  const hash = "ab".repeat(32);

  it("rejects malformed hashes before any engine call", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await bindCampaignFunding(makeAdmin(db) as never, CAMPAIGN, INTENT, OWNER, "nope");
    expect(result).toMatchObject({ kind: "error", reasonCode: "invalid_hash" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects non-owner binders without touching the engine", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await bindCampaignFunding(makeAdmin(db) as never, CAMPAIGN, INTENT, OTHER, hash);
    expect(result).toMatchObject({ kind: "error", reasonCode: "forbidden" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("delegates the normalized hash with settlement identity", async () => {
    const db: FakeDb = {
      tables: baseTables(),
      rpcCalls: [],
      rpcImpl: () => ({ result_kind: "bound", settlement_id: SETTLEMENT }),
    };
    const result = await bindCampaignFunding(makeAdmin(db) as never, CAMPAIGN, INTENT, OWNER, hash.toUpperCase());
    expect(result).toMatchObject({ kind: "bound", settlementId: SETTLEMENT, transactionHash: hash });
    expect(db.rpcCalls[0]).toMatchObject({
      fn: "bind_reward_funding_transaction_atomic",
      args: { _settlement_id: SETTLEMENT, _intent_id: INTENT, _transaction_hash: hash },
    });
  });
});

describe("confirmCampaignFunding", () => {
  it("maps unknown Campaigns and wrong funders without observation", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const admin = makeAdmin(db) as never;
    await expect(confirmCampaignFunding(admin, "nope", INTENT, OWNER)).resolves.toMatchObject({
      kind: "not_found",
      reasonCode: "campaign_not_found",
    });
    await expect(confirmCampaignFunding(admin, CAMPAIGN, INTENT, OTHER)).resolves.toMatchObject({
      kind: "forbidden",
    });
    expect(db.rpcCalls).toEqual([]);
  });

  it("surfaces the engine load failure for an unknown intent", async () => {
    const db: FakeDb = { tables: baseTables(), rpcCalls: [], rpcImpl: () => ({}) };
    const result = await confirmCampaignFunding(makeAdmin(db) as never, CAMPAIGN, INTENT, OWNER);
    expect(result).toMatchObject({ kind: "not_found", reasonCode: "intent_not_found" });
  });
});
