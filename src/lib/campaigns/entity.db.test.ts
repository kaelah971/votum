import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});
const anon = createClient(url, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "a".repeat(38);
const OTHER_OWNER = "01" + "b".repeat(38);
const PARTICIPATION_TYPES = [
  "public_giveaway",
  "secret_drop",
  "private_drop",
  "event_drop",
  "community_reward",
] as const;

const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function psql(sql: string): string {
  assertLocalSupabaseForTests();
  return execFileSync("docker", [
    "exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
}

function count(sql: string): number {
  return Number(psql(sql));
}

function createArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _owner_wallet: OWNER,
    _campaign_type: "public_giveaway",
    _visibility: "unlisted",
    _title: "Foundation campaign",
    _description: "A product-only foundation fixture.",
    _starts_at: null,
    _ends_at: null,
    _funding_mode: "creator",
    _funding_wallet: OWNER,
    _reward_per_participant_luna: 1000,
    _max_rewarded_participants: 10,
    _fee_reserve_luna: 0,
    ...overrides,
  };
}

async function createCampaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin.rpc(
    "create_participation_campaign_atomic",
    createArgs(overrides),
  );
  expect(error).toBeNull();
  const result = data as { campaign_id?: string; settlement_id?: string } | null;
  expect(result?.campaign_id).toBeTruthy();
  const campaignId = result?.campaign_id ?? "";
  createdCampaignIds.push(campaignId);
  if (result?.settlement_id) createdRootIds.push(result.settlement_id);
  return campaignId;
}

async function settlementIdFor(campaignId: string): Promise<string> {
  const { data, error } = await admin
    .from("participation_campaigns")
    .select("settlement_id")
    .eq("id", campaignId)
    .single();
  expect(error).toBeNull();
  expect(data?.settlement_id).toBeTruthy();
  return data?.settlement_id ?? "";
}

async function createRoot(ownerWallet = OWNER): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("reward_settlements").insert({
    id,
    owner_wallet: ownerWallet,
    funding_wallet: ownerWallet,
    refund_recipient_wallet: ownerWallet,
    funding_mode: "creator",
    asset: "NIM",
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 10,
    reward_principal_luna: 10000,
    fee_reserve_luna: 0,
    total_budget_luna: 10000,
    status: "configured",
  });
  expect(error).toBeNull();
  createdRootIds.push(id);
  return id;
}

async function insertCampaign(overrides: Record<string, unknown> = {}) {
  const settlementId = await createRoot(String(overrides.settlement_id ?? OWNER));
  const { data, error } = await admin.from("participation_campaigns").insert({
    settlement_id: settlementId,
    owner_wallet: OWNER,
    campaign_type: "public_giveaway",
    visibility: "unlisted",
    title: "Direct fixture",
    description: "Direct fixture",
    ...overrides,
  }).select("id").maybeSingle();
  if (data?.id) createdCampaignIds.push(data.id);
  return { data, error, settlementId };
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  if (count("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'participation_campaigns';") === 0) return;
  const campaignIds = createdCampaignIds.map((id) => `'${id}'`).join(", ") || "NULL";
  const rootIds = createdRootIds.map((id) => `'${id}'`).join(", ") || "NULL";
  psql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE settlement_id IN (${rootIds}));
    DELETE FROM public.reward_funding_transactions WHERE settlement_id IN (${rootIds});
    DELETE FROM public.reward_receipts WHERE settlement_id IN (${rootIds});
    DELETE FROM public.reward_refunds WHERE settlement_id IN (${rootIds});
    DELETE FROM public.reward_campaign_vaults WHERE settlement_id IN (${rootIds});
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${rootIds});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaignIds});
    DELETE FROM public.reward_settlements WHERE id IN (${rootIds});
    COMMIT;
  `);
});

describe("V2C.2C Campaign foundation schema", () => {
  it("creates the product-only table and final binding branches", () => {
    expect(count("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'participation_campaigns';")).toBe(1);
    expect(psql(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'participation_campaigns'
      ORDER BY ordinal_position;
    `).split("\n")).toEqual([
      "id", "settlement_id", "owner_wallet", "campaign_type", "visibility", "title",
      "description", "status", "configuration_version", "published_configuration_version",
      "starts_at", "ends_at", "close_reason", "configuration_locked_at", "published_at",
      "closed_at", "created_at", "updated_at",
    ]);
    expect(count(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'participation_campaigns'
        AND column_name IN ('claimable', 'secret', 'allowlist', 'event_proof', 'community_membership', 'vault', 'receipt', 'payout', 'refund');
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('campaign_claims', 'campaign_secrets', 'campaign_allowlists', 'campaign_event_proofs', 'campaign_memberships');
    `)).toBe(0);
    expect(psql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settlement_source_bindings'
      ORDER BY ordinal_position;
    `).split("\n")).toEqual([
      "settlement_id", "source_type", "reward_campaign_id", "created_at", "participation_campaign_id",
    ]);
  });

  it("accepts exactly the five product type literals as draft foundations", async () => {
    for (const campaignType of PARTICIPATION_TYPES) {
      const campaignId = await createCampaign({ _campaign_type: campaignType });
      const { data, error } = await admin
        .from("participation_campaigns")
        .select("campaign_type, status, settlement_id")
        .eq("id", campaignId)
        .single();
      expect(error).toBeNull();
      expect(data).toMatchObject({ campaign_type: campaignType, status: "draft" });
      expect(data?.settlement_id).toBeTruthy();
    }
  });

  it("rejects invalid product values and windows at the database boundary", async () => {
    for (const overrides of [
      { campaign_type: "unsupported" },
      { visibility: "hidden" },
      { status: "claimable" },
      { title: "" },
      { title: "x".repeat(161) },
      { description: "x".repeat(4001) },
      { configuration_version: 0 },
      { published_configuration_version: 0 },
      { owner_wallet: "bad" },
      { starts_at: "2026-10-02T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" },
      { close_reason: "not-approved" },
    ]) {
      const result = await insertCampaign(overrides);
      expect(result.error).not.toBeNull();
    }
  });

  it("enforces canonical ownership, exact source binding, and Poll isolation", async () => {
    const campaignId = await createCampaign();
    const settlementId = await settlementIdFor(campaignId);
    expect(count(`SELECT COUNT(*) FROM public.reward_campaigns WHERE id = '${campaignId}';`)).toBe(0);
    expect(count(`
      SELECT COUNT(*) FROM public.settlement_source_bindings
      WHERE settlement_id = '${settlementId}' AND source_type = 'participation_campaign'
        AND participation_campaign_id = '${campaignId}' AND reward_campaign_id IS NULL;
    `)).toBe(1);

    const rootOwnerAttempt = await admin.from("reward_settlements")
      .update({ owner_wallet: OTHER_OWNER })
      .eq("id", settlementId);
    expect(rootOwnerAttempt.error).not.toBeNull();

    const bindingDelete = await admin.from("settlement_source_bindings")
      .delete()
      .eq("settlement_id", settlementId);
    expect(bindingDelete.error).not.toBeNull();

    const pollSettlement = psql(`
      SELECT settlement_id FROM public.settlement_source_bindings
      WHERE source_type = 'poll_reward_campaign' LIMIT 1;
    `);
    const pollAttempt = await admin.from("participation_campaigns").insert({
      settlement_id: pollSettlement,
      owner_wallet: OWNER,
      campaign_type: "public_giveaway",
      visibility: "unlisted",
      title: "Poll collision",
    });
    expect(pollAttempt.error).not.toBeNull();

    const mismatchedRoot = await createRoot(OTHER_OWNER);
    const ownerAttempt = await admin.from("participation_campaigns").insert({
      settlement_id: mismatchedRoot,
      owner_wallet: OWNER,
      campaign_type: "public_giveaway",
      visibility: "unlisted",
      title: "Owner collision",
    });
    expect(ownerAttempt.error).not.toBeNull();

    const unboundRoot = await createRoot();
    const unboundAttempt = await admin.from("participation_campaigns").insert({
      settlement_id: unboundRoot,
      owner_wallet: OWNER,
      campaign_type: "public_giveaway",
      visibility: "unlisted",
      title: "Missing binding",
    });
    expect(unboundAttempt.error).not.toBeNull();

    const secondCampaign = await createCampaign();
    const secondSettlementId = await settlementIdFor(secondCampaign);
    const rebind = await admin.from("participation_campaigns")
      .update({ settlement_id: secondSettlementId })
      .eq("id", campaignId);
    expect(rebind.error).not.toBeNull();
  });

  it("keeps product and financial lifecycles separate and locks publication", async () => {
    const campaignId = await createCampaign();
    const settlementId = await settlementIdFor(campaignId);
    const updated = await admin.rpc("update_participation_campaign_draft_atomic", {
      _campaign_id: campaignId,
      _title: "Updated foundation campaign",
      _description: "Updated product configuration.",
      _campaign_type: "public_giveaway",
      _visibility: "public",
      _starts_at: null,
      _ends_at: null,
      _configuration_version: 2,
      _funding_mode: "creator",
      _funding_wallet: OWNER,
      _reward_per_participant_luna: 2000,
      _max_rewarded_participants: 20,
      _fee_reserve_luna: 100,
    });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ campaign_id: campaignId, status: "draft", configuration_version: 2 });

    const { data: published, error: publishError } = await admin.rpc(
      "publish_participation_campaign_atomic",
      { _campaign_id: campaignId, _published_configuration_version: 2 },
    );
    expect(publishError).toBeNull();
    expect(published).toMatchObject({ campaign_id: campaignId, status: "published" });

    const { data: campaign } = await admin.from("participation_campaigns")
      .select("status, configuration_locked_at, settlement_id")
      .eq("id", campaignId)
      .single();
    const { data: root } = await admin.from("reward_settlements")
      .select("status, funded_amount_luna, reward_per_participant_luna, max_rewarded_participants, reward_principal_luna, fee_reserve_luna, total_budget_luna")
      .eq("id", settlementId)
      .single();
    expect(campaign?.status).toBe("published");
    expect(campaign?.configuration_locked_at).not.toBeNull();
    expect(root).toMatchObject({
      status: "configured",
      funded_amount_luna: 0,
      reward_per_participant_luna: 2000,
      max_rewarded_participants: 20,
      reward_principal_luna: 40000,
      fee_reserve_luna: 100,
      total_budget_luna: 40100,
    });

    const titleUpdate = await admin.from("participation_campaigns")
      .update({ title: "Changed after publication" })
      .eq("id", campaignId);
    expect(titleUpdate.error).not.toBeNull();

    const unsupportedPublish = await createCampaign({ _campaign_type: "secret_drop" });
    const unsupportedResult = await admin.rpc(
      "publish_participation_campaign_atomic",
      { _campaign_id: unsupportedPublish, _published_configuration_version: 1 },
    );
    expect(unsupportedResult.error).not.toBeNull();

    const anonCreate = await anon.rpc("create_participation_campaign_atomic", createArgs());
    expect(anonCreate.error).not.toBeNull();
  });

  it("keeps private foundation access service-role-only and creates no financial child", async () => {
    const beforePollRoots = count("SELECT COUNT(*) FROM public.settlement_source_bindings WHERE source_type = 'poll_reward_campaign';");
    const campaignId = await createCampaign();
    const settlementId = await settlementIdFor(campaignId);
    expect(count(`SELECT COUNT(*) FROM public.reward_funding_transactions WHERE settlement_id = '${settlementId}';`)).toBe(0);
    expect(count(`SELECT COUNT(*) FROM public.reward_receipts WHERE settlement_id = '${settlementId}';`)).toBe(0);
    expect(count(`SELECT COUNT(*) FROM public.reward_refunds WHERE settlement_id = '${settlementId}';`)).toBe(0);
    expect(count(`SELECT COUNT(*) FROM public.reward_campaign_vaults WHERE settlement_id = '${settlementId}';`)).toBe(0);
    expect(count("SELECT COUNT(*) FROM public.settlement_source_bindings WHERE source_type = 'poll_reward_campaign';")).toBe(beforePollRoots);

    const publicRead = await anon.from("participation_campaigns").select("id").limit(1);
    expect(publicRead.data).toBeNull();
    expect(publicRead.error).not.toBeNull();
    const publicWrite = await anon.from("participation_campaigns").insert({
      settlement_id: settlementId,
      owner_wallet: OWNER,
      campaign_type: "public_giveaway",
      visibility: "unlisted",
      title: "Browser write",
    });
    expect(publicWrite.error).not.toBeNull();
    const bindingRead = await anon.from("settlement_source_bindings").select("settlement_id").limit(1);
    expect(bindingRead.data).toBeNull();
    expect(bindingRead.error).not.toBeNull();
    const rootRead = await anon.from("reward_settlements").select("id").limit(1);
    expect(rootRead.data).toBeNull();
    expect(rootRead.error).not.toBeNull();
  });
});
