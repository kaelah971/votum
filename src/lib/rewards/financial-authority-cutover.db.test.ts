import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";
import {
  createPollCampaignFixture,
  deletePollCampaignFixtureSql,
  type PollCampaignFixture,
} from "@/lib/rewards/settlement-fixture";
import { ensureCampaignVault, withCampaignVaultKey } from "@/lib/rewards/vault-service";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function psql(sql: string): string {
  assertLocalSupabaseForTests();
  return execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
}

function count(sql: string): number {
  return Number(psql(sql));
}

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
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c",
    deletePollCampaignFixtureSql(fixtureCampaignIds, fixturePollIds),
  ], { stdio: "pipe" });
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanupFixtures());
afterAll(() => cleanupFixtures());

describe("V2C.2E financial authority cutover", () => {
  it("makes settlement_id the vault identity and preserves Poll compatibility", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reward_campaign_vaults'
        AND column_name = 'settlement_id'
        AND is_nullable = 'NO';
    `)).toBe(1);
    expect(count(`
      SELECT COUNT(*)
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE t.relname = 'reward_campaign_vaults'
        AND c.contype = 'p'
        AND a.attname = 'settlement_id';
    `)).toBe(1);
    expect(count(`
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reward_campaign_vaults'
        AND column_name = 'campaign_id'
        AND is_nullable = 'YES';
    `)).toBe(1);
    expect(count(`
      SELECT COUNT(*)
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'idx_reward_campaign_vaults_campaign_compat';
    `)).toBe(1);
  });

  it("has complete root, binding, child, vault, and accounting coverage", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaigns c
      LEFT JOIN public.reward_settlements s ON s.id = c.settlement_id
      LEFT JOIN public.settlement_source_bindings b
        ON b.reward_campaign_id = c.id
       AND b.source_type = 'poll_reward_campaign'
      WHERE c.settlement_id IS NULL OR s.id IS NULL
         OR b.settlement_id IS DISTINCT FROM c.settlement_id;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_funding_transactions f
      LEFT JOIN public.reward_settlements s ON s.id = f.settlement_id
      WHERE f.settlement_id IS NULL OR s.id IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_receipts r
      LEFT JOIN public.reward_settlements s ON s.id = r.settlement_id
      WHERE r.settlement_id IS NULL OR s.id IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_refunds r
      LEFT JOIN public.reward_settlements s ON s.id = r.settlement_id
      WHERE r.settlement_id IS NULL OR s.id IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      LEFT JOIN public.reward_settlements s ON s.id = v.settlement_id
      WHERE v.settlement_id IS NULL OR s.id IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults
      GROUP BY settlement_id
      HAVING COUNT(*) <> 1;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_settlements s
      WHERE s.reward_principal_luna <> s.reward_per_participant_luna * s.max_rewarded_participants
         OR s.total_budget_luna <> s.reward_principal_luna + s.fee_reserve_luna
         OR s.paid_amount_luna + s.fee_spent_luna > s.funded_amount_luna;
    `)).toBe(0);
  });

  it("freezes old campaign economics instead of dual-writing them", async () => {
    const fixture = trackFixture(await createPollCampaignFixture(admin));
    const campaign = await admin
      .from("reward_campaigns")
      .select("id, reward_per_participant_luna")
      .eq("id", fixture.campaignId)
      .maybeSingle();
    expect(campaign.error).toBeNull();
    expect(campaign.data).not.toBeNull();
    if (!campaign.data) return;

    const update = await admin
      .from("reward_campaigns")
      .update({ reward_per_participant_luna: campaign.data.reward_per_participant_luna + 1 })
      .eq("id", campaign.data.id);
    expect(update.error).not.toBeNull();

    const root = await admin
      .from("reward_settlements")
      .select("reward_per_participant_luna")
      .eq("id", campaign.data.id)
      .single();
    expect(root.error).toBeNull();
    expect(root.data?.reward_per_participant_luna).toBe(campaign.data.reward_per_participant_luna);
  });

  it("keeps existing Poll vaults decryptable through settlement-rooted lookup", async () => {
    const fixture = trackFixture(await createPollCampaignFixture(admin));
    const created = await ensureCampaignVault(fixture.campaignId);
    expect(created.vaultAddressHex).toMatch(/^[0-9a-f]+$/);

    const { data: rows, error } = await admin
      .from("reward_campaign_vaults")
      .select("settlement_id, campaign_id, vault_address_hex, envelope_version, encryption_algorithm, encrypted_private_key_ciphertext")
      .eq("settlement_id", fixture.campaignId)
      .neq("encrypted_private_key_ciphertext", "fixture-ciphertext")
      .order("created_at", { ascending: false })
      .limit(10);
    expect(error).toBeNull();
    expect(rows?.length).toBeGreaterThan(0);

    let decryptable = false;
    for (const row of rows ?? []) {
       expect(row.settlement_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.envelope_version).toBe("votum:reward-vault:v1");
      expect(row.encryption_algorithm).toBe("aes-256-gcm");
      try {
        const address = await withCampaignVaultKey(row.settlement_id, (keypair) => keypair.toAddress().toHex());
        expect(address).toBe(row.vault_address_hex);
        decryptable = true;
        break;
      } catch {
        // Historical local rows may be non-cryptographic fixture envelopes.
      }
    }
    expect(decryptable).toBe(true);
  });

  it("does not expose campaign-rooted authority in cutover RPC bodies", () => {
    const functions = [
      "begin_reward_funding_atomic", "bind_reward_funding_transaction_atomic",
      "confirm_reward_funding_atomic", "claim_reward_receipt_atomic",
      "begin_reward_payout_atomic", "prepare_reward_payout_atomic",
      "retry_reward_payout_atomic", "acquire_reward_payout_vault_lock_atomic",
      "confirm_reward_payout_atomic", "release_reward_payout_vault_lock_atomic",
      "begin_reward_refund_atomic", "prepare_reward_refund_transaction_atomic",
      "confirm_reward_refund_atomic", "acquire_reward_refund_vault_lock_atomic",
    ];
    for (const name of functions) {
      const definition = psql(`
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${name}'
        LIMIT 1;
      `);
      expect(definition, name).not.toMatch(/UPDATE\s+public\.reward_campaigns/i);
      expect(definition, name).toMatch(/reward_settlements/i);
    }
  });
});
