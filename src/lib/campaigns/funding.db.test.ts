import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign } from "@/lib/campaigns/configuration";
import {
  beginCampaignFunding,
  bindCampaignFunding,
  confirmCampaignFunding,
} from "@/lib/campaigns/funding";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { createRewardSettlementService } from "@/lib/rewards/settlement";
import { resolveCampaignRewardSettlement } from "@/lib/campaigns/settlement";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";
import {
  createPollCampaignFixture,
  deletePollCampaignFixtureSql,
} from "@/lib/rewards/settlement-fixture";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const OTHER = "01" + "d".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];
const pollCampaignIds: string[] = [];
const pollIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function count(sql: string): number {
  return Number(execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim());
}

async function createCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Campaign funding adapter fixture",
    description: null,
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result.campaign;
}

function fundingRowCount(settlementId: string): number {
  return count(
    `SELECT COUNT(*) FROM public.reward_funding_transactions WHERE settlement_id = '${settlementId}';`,
  );
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  if (pollCampaignIds.length > 0) {
    runPsql(deletePollCampaignFixtureSql(pollCampaignIds, pollIds));
    pollCampaignIds.length = 0;
    pollIds.length = 0;
  }
  if (createdCampaignIds.length === 0) return;
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE settlement_id IN (${roots}));
    DELETE FROM public.reward_funding_transactions WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_receipts WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_refunds WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_campaign_vaults WHERE settlement_id IN (${roots});
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${roots});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${roots});
    COMMIT;
  `);
  createdCampaignIds.length = 0;
  createdRootIds.length = 0;
});

describe("V2C.3A Campaign funding adapter without Campaign funding rows", () => {
  it("resolves the Campaign branch with the canonical owner and server amount", async () => {
    const campaign = await createCampaign();
    const resolution = await resolveCampaignRewardSettlement(admin as never, campaign.campaignId);
    expect(resolution).toMatchObject({
      kind: "ok",
      settlementId: campaign.settlementId,
      participationCampaignId: campaign.campaignId,
      ownerWallet: OWNER,
    });

    const { data: root } = await admin.from("reward_settlements")
      .select("total_budget_luna, funding_wallet, funding_mode")
      .eq("id", campaign.settlementId)
      .single();
    expect(root).toMatchObject({
      total_budget_luna: 580000,
      funding_wallet: OWNER,
      funding_mode: "creator",
    });
  });

  it("derives vault readiness from the settlement vault without writes", async () => {
    const campaign = await createCampaign();
    const vault = await ensureRewardSettlementVault(campaign.settlementId);
    expect(vault.campaignId).toBeNull();
    expect(vault.vaultAddressHex).toMatch(/^[0-9a-f]{40}$/);
    expect(fundingRowCount(campaign.settlementId)).toBe(0);
  });

  it("rejects non-owner funding without writing any funding row", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    const result = await beginCampaignFunding(admin as never, campaign.campaignId, OTHER);
    expect(result).toMatchObject({ kind: "error", reasonCode: "forbidden" });
    expect(fundingRowCount(campaign.settlementId)).toBe(0);
  });

  it("rejects unknown Campaigns and missing vaults without writes", async () => {
    const campaign = await createCampaign();
    await expect(
      beginCampaignFunding(admin as never, "00000000-0000-0000-0000-000000000000", OWNER),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_not_found" });

    await expect(
      beginCampaignFunding(admin as never, campaign.campaignId, OWNER),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "vault_unavailable" });
    expect(fundingRowCount(campaign.settlementId)).toBe(0);

    await expect(
      bindCampaignFunding(admin as never, campaign.campaignId, "00000000-0000-0000-0000-000000000000", OTHER, hex(32)),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "forbidden" });
    await expect(
      confirmCampaignFunding(admin as never, campaign.campaignId, "00000000-0000-0000-0000-000000000000", OWNER),
    ).resolves.toMatchObject({ kind: "not_found", reasonCode: "intent_not_found" });
  });
});

describe("V2C.3A settlement engine delegation on Poll fixtures", () => {
  it("begins, replays, and binds funding through the existing engine", async () => {
    const fixture = await createPollCampaignFixture(admin as never);
    pollCampaignIds.push(fixture.campaignId);
    pollIds.push(fixture.pollId);
    await ensureRewardSettlementVault(fixture.campaignId);
    const engine = createRewardSettlementService(admin as never);

    const created = await engine.beginFunding(fixture.campaignId, fixture.creatorWallet);
    expect(created.kind).toBe("created");
    if (created.kind !== "created") throw new Error("expected created intent");
    expect(created.fundingIntent.requiredFundingLuna).toBe("11000");

    const replay = await engine.beginFunding(fixture.campaignId, fixture.creatorWallet);
    expect(replay.kind).toBe("replay");

    const transactionHash = hex(32);
    const bound = await engine.bindFunding(
      fixture.campaignId,
      created.fundingIntent.fundingIntentId,
      fixture.creatorWallet,
      transactionHash,
    );
    expect(bound).toMatchObject({ kind: "bound", transactionHash });
  });

  it("enforces cross-ledger hash reuse protection", async () => {
    const first = await createPollCampaignFixture(admin as never);
    const second = await createPollCampaignFixture(admin as never);
    pollCampaignIds.push(first.campaignId, second.campaignId);
    pollIds.push(first.pollId, second.pollId);
    await ensureRewardSettlementVault(first.campaignId);
    await ensureRewardSettlementVault(second.campaignId);
    const engine = createRewardSettlementService(admin as never);

    const transactionHash = hex(32);
    const firstIntent = await engine.beginFunding(first.campaignId, first.creatorWallet);
    if (firstIntent.kind !== "created") throw new Error("expected created intent");
    await engine.bindFunding(
      first.campaignId,
      firstIntent.fundingIntent.fundingIntentId,
      first.creatorWallet,
      transactionHash,
    );

    const secondIntent = await engine.beginFunding(second.campaignId, second.creatorWallet);
    if (secondIntent.kind !== "created") throw new Error("expected created intent");
    const reuse = await engine.bindFunding(
      second.campaignId,
      secondIntent.fundingIntent.fundingIntentId,
      second.creatorWallet,
      transactionHash,
    );
    expect(reuse).toMatchObject({ kind: "error", reasonCode: "transaction_already_reserved" });
  });
});
