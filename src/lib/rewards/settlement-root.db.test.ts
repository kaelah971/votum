import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";
import {
  createPollCampaignFixture,
  deletePollCampaignFixtureSql,
  type PollCampaignFixture,
} from "@/lib/rewards/settlement-fixture";
import {
  loadRewardSettlementContext,
  resolvePollRewardSettlement,
} from "@/lib/rewards/settlement-root";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";

const url = testSupabaseUrl();
const adminKey = testSupabaseKey();
const publishableKey = process.env.VOTUM_CLEANROOM_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

const admin = createClient(url, adminKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});
const anon = createClient(url, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function psql(sql: string): string {
  assertLocalSupabaseForTests();
  return execFileSync("docker", [
    "exec",
    testDbContainer(),
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-c",
    sql,
  ], { encoding: "utf8" }).trim();
}

function count(sql: string): number {
  return Number(psql(sql));
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

const fixtureCampaignIds: string[] = [];
const fixturePollIds: string[] = [];

function trackFixture(fixture: PollCampaignFixture): PollCampaignFixture {
  fixtureCampaignIds.push(fixture.campaignId);
  fixturePollIds.push(fixture.pollId);
  return fixture;
}

function cleanupFixtures(): void {
  if (fixtureCampaignIds.length === 0) return;
  execFileSync("docker", [
    "exec",
    testDbContainer(),
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    deletePollCampaignFixtureSql(fixtureCampaignIds, fixturePollIds),
  ], { stdio: "pipe" });
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

afterEach(() => {
  cleanupFixtures();
});

afterAll(() => {
  cleanupFixtures();
});

describe("V2C.2A settlement root schema", () => {
  it("creates the source-neutral root with the approved columns and constraints", () => {
    expect(count("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reward_settlements';")).toBe(1);

    const columns = psql("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reward_settlements' ORDER BY ordinal_position;").split("\n");
    expect(columns).toEqual([
      "id",
      "owner_wallet",
      "funding_wallet",
      "refund_recipient_wallet",
      "funding_mode",
      "asset",
      "reward_per_participant_luna",
      "max_rewarded_participants",
      "reward_principal_luna",
      "fee_reserve_luna",
      "total_budget_luna",
      "status",
      "funded_amount_luna",
      "refundable_excess_luna",
      "rewarded_participant_count",
      "paid_amount_luna",
      "fee_spent_luna",
      "refundable_amount_luna",
      "first_reservation_at",
      "payout_lock_attempt_id",
      "payout_lock_expires_at",
      "payout_lock_token",
      "created_at",
      "funded_at",
      "closed_at",
      "refunded_at",
      "updated_at",
    ]);

    const forbidden = psql("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reward_settlements' AND column_name IN ('poll_id', 'option_id', 'participation_campaign_id', 'campaign_type', 'claim_evidence', 'secret', 'allowlist', 'event_proof');");
    expect(forbidden).toBe("");

    const checks = psql("SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'reward_settlements' AND c.contype = 'c' ORDER BY conname;").split("\n");
    expect(checks).toEqual(expect.arrayContaining([
      "reward_settlements_asset",
      "reward_settlements_creator_funding",
      "reward_settlements_funding_mode",
      "reward_settlements_no_overspend",
      "reward_settlements_principal_math",
      "reward_settlements_refund_destination",
      "reward_settlements_status",
      "reward_settlements_total_math",
      "reward_settlements_wallet_shape",
    ]));
  });

  it("keeps the root private from anonymous and authenticated table access", async () => {
    const publicRead = await anon.from("reward_settlements").select("id").limit(1);
    expect(publicRead.data).toBeNull();
    expect(publicRead.error).not.toBeNull();

    const authRead = await anon.from("settlement_source_bindings").select("settlement_id").limit(1);
    expect(authRead.data).toBeNull();
    expect(authRead.error).not.toBeNull();
  });
});

describe("V2C.2A Poll backfill", () => {
  it("backfills one stable root and one Poll binding per reward campaign", async () => {
    const { data: campaigns, error: campaignError } = await admin
      .from("reward_campaigns")
      .select("id, poll_id, settlement_id, creator_wallet, funding_wallet")
      .not("settlement_id", "is", null);
    expect(campaignError).toBeNull();
    expect(campaigns).not.toBeNull();

    const { data: roots, error: rootError } = await admin
      .from("reward_settlements")
      .select("id, owner_wallet, funding_wallet, refund_recipient_wallet");
    expect(rootError).toBeNull();
    expect(roots).not.toBeNull();

    const { data: bindings, error: bindingError } = await admin
      .from("settlement_source_bindings")
      .select("settlement_id, source_type, reward_campaign_id");
    expect(bindingError).toBeNull();
    expect(bindings).not.toBeNull();

    const campaignRows = campaigns ?? [];
    const rootRows = roots ?? [];
    const bindingRows = bindings ?? [];
    expect(rootRows.length).toBe(campaignRows.length);
    expect(bindingRows.length).toBe(campaignRows.length);

    for (const campaign of campaignRows) {
      const root = rootRows.find((row) => row.id === campaign.id);
      const binding = bindingRows.find((row) => row.reward_campaign_id === campaign.id);
      expect(campaign.settlement_id).toBe(campaign.id);
      expect(root).toBeDefined();
      expect(binding).toMatchObject({
        settlement_id: campaign.id,
        source_type: "poll_reward_campaign",
        reward_campaign_id: campaign.id,
      });
      expect(root?.owner_wallet).toBe(normalizeAddress(campaign.creator_wallet));
      expect(root?.funding_wallet).toBe(normalizeAddress(campaign.funding_wallet));
      expect(root?.refund_recipient_wallet).toBe(normalizeAddress(campaign.creator_wallet));
    }
  });

  it("copies every financial value and status without reinterpreting live authority", async () => {
    const { data: campaigns, error } = await admin
      .from("reward_campaigns")
      .select("*")
      .not("settlement_id", "is", null);
    expect(error).toBeNull();

    for (const campaign of campaigns ?? []) {
      const { data: root, error: rootError } = await admin
        .from("reward_settlements")
        .select("*")
        .eq("id", campaign.id)
        .single();
      expect(rootError).toBeNull();
      expect(root).toMatchObject({
        id: campaign.id,
        owner_wallet: normalizeAddress(campaign.creator_wallet),
        funding_wallet: normalizeAddress(campaign.funding_wallet),
        refund_recipient_wallet: normalizeAddress(campaign.creator_wallet),
        funding_mode: campaign.funding_mode,
        asset: campaign.asset,
        reward_per_participant_luna: campaign.reward_per_participant_luna,
        max_rewarded_participants: campaign.max_rewarded_participants,
        reward_principal_luna: campaign.reward_principal_luna,
        fee_reserve_luna: campaign.fee_reserve_luna,
        total_budget_luna: campaign.total_budget_luna,
        status: campaign.status,
        funded_amount_luna: campaign.funded_amount_luna,
        refundable_excess_luna: campaign.refundable_excess_luna,
        rewarded_participant_count: campaign.rewarded_participant_count,
        paid_amount_luna: campaign.paid_amount_luna,
        fee_spent_luna: campaign.fee_spent_luna,
        refundable_amount_luna: campaign.refundable_amount_luna,
        first_reservation_at: campaign.first_reservation_at,
        payout_lock_attempt_id: campaign.payout_lock_attempt_id,
        payout_lock_expires_at: campaign.payout_lock_expires_at,
        payout_lock_token: campaign.payout_lock_token,
        created_at: campaign.created_at,
        funded_at: campaign.funded_at,
        closed_at: campaign.closed_at,
        refunded_at: campaign.refunded_at,
        updated_at: campaign.updated_at,
      });
    }

    expect(count("SELECT COUNT(*) FROM public.reward_settlements WHERE reward_principal_luna <> reward_per_participant_luna * max_rewarded_participants OR total_budget_luna <> reward_principal_luna + fee_reserve_luna OR rewarded_participant_count < 0 OR rewarded_participant_count > max_rewarded_participants OR paid_amount_luna < 0 OR fee_spent_luna < 0 OR paid_amount_luna + fee_spent_luna > funded_amount_luna OR refundable_excess_luna < 0 OR refundable_amount_luna < 0;")).toBe(0);
  });

  it("rejects duplicate or malformed binding/root writes", async () => {
    const fixture = trackFixture(await createPollCampaignFixture(admin));
    const { data: campaign } = await admin
      .from("reward_campaigns")
      .select("id, poll_id")
      .eq("id", fixture.campaignId)
      .not("settlement_id", "is", null)
      .limit(1)
      .single();
    expect(campaign).not.toBeNull();
    if (!campaign) return;

    const duplicateBinding = await admin.from("settlement_source_bindings").insert({
      settlement_id: campaign.id,
      source_type: "poll_reward_campaign",
      reward_campaign_id: campaign.id,
    });
    expect(duplicateBinding.error).not.toBeNull();

    const malformedRoot = await admin.from("reward_settlements").insert({
      id: "33333333-3333-4333-8333-333333333333",
      owner_wallet: "bad",
      funding_wallet: "bad",
      refund_recipient_wallet: "bad",
      funding_mode: "creator",
      asset: "NIM",
      reward_per_participant_luna: 1000,
      max_rewarded_participants: 1,
      reward_principal_luna: 1000,
      fee_reserve_luna: 0,
      total_budget_luna: 1000,
      status: "configured",
    });
    expect(malformedRoot.error).not.toBeNull();
  });

  it("keeps Poll identity constraints and excludes Campaign/child/vault changes", () => {
    expect(count("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reward_campaigns' AND column_name = 'settlement_id';")).toBe(1);
    expect(count("SELECT COUNT(*) FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'reward_campaigns' AND a.attname = 'poll_id' AND a.attnotnull;")).toBe(1);
    expect(count("SELECT COUNT(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'reward_campaigns' AND c.conname = 'reward_campaigns_poll_id_key' AND c.contype = 'u';")).toBe(1);
    expect(count("SELECT COUNT(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'reward_campaigns' AND c.conname = 'reward_campaigns_poll_id_fkey' AND c.contype = 'f';")).toBe(1);
    const migration = readFileSync("supabase/migrations/20260913081000_v2c2_poll_settlement_backfill.sql", "utf8");
    expect(migration).not.toMatch(/participation_campaigns/);
    expect(migration).not.toMatch(/reward_funding_transactions|reward_receipts|reward_refunds|reward_campaign_vaults|reward_payout_attempts/);
    expect(migration).not.toMatch(/encrypted_private_key|authentication_tag|encryption_iv|vault_address_hex/);
  });
});

describe("V2C.2E settlement-root authority boundary", () => {
  it("routes existing financial RPCs through reward_settlements", () => {
    const functionNames = [
      "begin_reward_funding_atomic",
      "bind_reward_funding_transaction_atomic",
      "confirm_reward_funding_atomic",
      "claim_reward_receipt_atomic",
      "begin_reward_payout_atomic",
      "prepare_reward_payout_atomic",
      "retry_reward_payout_atomic",
      "confirm_reward_payout_atomic",
      "begin_reward_refund_atomic",
      "prepare_reward_refund_transaction_atomic",
      "confirm_reward_refund_atomic",
    ];
    const names = functionNames.map((name) => `'${name}'`).join(",");
    const result = psql(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN (${names}) AND pg_get_functiondef(p.oid) ILIKE '%reward_settlements%';`);
    expect(new Set(result.split("\n"))).toEqual(new Set(functionNames));
  });

  it("resolves the backfilled Poll binding through the read-only root loader", async () => {
    const fixture = trackFixture(await createPollCampaignFixture(admin));
    const { data: campaign } = await admin
      .from("reward_campaigns")
      .select("id, poll_id")
      .eq("id", fixture.campaignId)
      .not("settlement_id", "is", null)
      .limit(1)
      .single();
    expect(campaign).not.toBeNull();
    if (!campaign) return;

    await expect(resolvePollRewardSettlement(admin as never, campaign.poll_id)).resolves.toMatchObject({
      kind: "ok",
      settlementId: campaign.id,
      rewardCampaignId: campaign.id,
      pollId: campaign.poll_id,
      sourceType: "poll_reward_campaign",
    });
    await expect(loadRewardSettlementContext(admin as never, campaign.id)).resolves.toMatchObject({
      kind: "ok",
      root: { settlementId: campaign.id },
    });
  });
});
