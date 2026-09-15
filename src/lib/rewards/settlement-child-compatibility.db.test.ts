import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";
import {
  createPollCampaignFixture,
  deletePollCampaignFixtureSql,
  type PollCampaignFixture,
} from "@/lib/rewards/settlement-fixture";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function trackFixture(fixture: PollCampaignFixture): PollCampaignFixture {
  fixtureCampaignIds.push(fixture.campaignId);
  fixturePollIds.push(fixture.pollId);
  return fixture;
}

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

beforeAll(() => {
  assertLocalSupabaseForTests();
});

const fixtureCampaignIds: string[] = [];
const fixturePollIds: string[] = [];

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

afterEach(() => {
  cleanupFixtures();
});

afterAll(() => {
  cleanupFixtures();
});

describe("V2C.2E settlement child schema", () => {
  it("has settlement-root references with the approved nullability", () => {
    expect(psql(`
      SELECT table_name || ':' || is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'settlement_id'
        AND table_name IN (
          'reward_funding_transactions', 'reward_receipts',
          'reward_refunds', 'reward_campaign_vaults'
        )
      ORDER BY table_name;
    `).split("\n")).toEqual([
      "reward_campaign_vaults:NO",
      "reward_funding_transactions:NO",
      "reward_receipts:NO",
      "reward_refunds:NO",
    ]);

    expect(count(`
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reward_payout_attempts'
        AND column_name = 'settlement_id';
    `)).toBe(0);

    expect(psql(`
      SELECT conrelid::regclass::text || ':' || conname
      FROM pg_constraint
      WHERE conname IN (
        'reward_funding_transactions_settlement_id_fkey',
        'reward_receipts_settlement_id_fkey',
        'reward_refunds_settlement_id_fkey',
        'reward_campaign_vaults_settlement_id_fkey'
      )
      ORDER BY conrelid::regclass::text;
    `).split("\n")).toEqual([
      "reward_campaign_vaults:reward_campaign_vaults_settlement_id_fkey",
      "reward_funding_transactions:reward_funding_transactions_settlement_id_fkey",
      "reward_receipts:reward_receipts_settlement_id_fkey",
      "reward_refunds:reward_refunds_settlement_id_fkey",
    ]);
  });

  it("has complete settlement coverage for all existing financial children", () => {
    for (const table of [
      "reward_funding_transactions",
      "reward_receipts",
      "reward_refunds",
      "reward_campaign_vaults",
    ]) {
      expect(count(`SELECT COUNT(*) FROM public.${table} WHERE settlement_id IS NULL;`)).toBe(0);
    }

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaigns c
      LEFT JOIN public.reward_funding_transactions f ON f.campaign_id = c.id
      WHERE f.id IS NOT NULL AND f.settlement_id IS DISTINCT FROM c.settlement_id;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaigns c
      LEFT JOIN public.reward_receipts r ON r.campaign_id = c.id
      WHERE r.id IS NOT NULL
        AND (r.settlement_id IS DISTINCT FROM c.settlement_id OR r.poll_id IS DISTINCT FROM c.poll_id);
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaigns c
      LEFT JOIN public.reward_refunds r ON r.campaign_id = c.id
      WHERE r.id IS NOT NULL
        AND (r.settlement_id IS DISTINCT FROM c.settlement_id
          OR lower(trim(r.creator_wallet)) IS DISTINCT FROM lower(trim(c.creator_wallet)));
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaigns c
      LEFT JOIN public.reward_campaign_vaults v ON v.campaign_id = c.id
      WHERE v.campaign_id IS NOT NULL AND v.settlement_id IS DISTINCT FROM c.settlement_id;
    `)).toBe(0);
  });

  it("agrees with the Poll binding and root owner/funder policy", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_funding_transactions f
      JOIN public.reward_campaigns c ON c.id = f.campaign_id
      JOIN public.reward_settlements s ON s.id = f.settlement_id
      LEFT JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      WHERE b.source_type IS DISTINCT FROM 'poll_reward_campaign'
         OR f.settlement_id IS DISTINCT FROM c.settlement_id
         OR f.settlement_id IS DISTINCT FROM b.settlement_id
         OR lower(trim(f.creator_wallet)) IS DISTINCT FROM lower(trim(s.owner_wallet))
         OR lower(trim(f.funder_wallet)) IS DISTINCT FROM lower(trim(s.funding_wallet));
    `)).toBe(0);

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_receipts r
      JOIN public.reward_campaigns c ON c.id = r.campaign_id
      JOIN public.reward_settlements s ON s.id = r.settlement_id
      LEFT JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      WHERE b.source_type IS DISTINCT FROM 'poll_reward_campaign'
         OR r.settlement_id IS DISTINCT FROM c.settlement_id
         OR r.settlement_id IS DISTINCT FROM b.settlement_id
         OR r.poll_id IS DISTINCT FROM c.poll_id
         OR lower(trim(s.owner_wallet)) IS DISTINCT FROM lower(trim(c.creator_wallet));
    `)).toBe(0);

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_refunds r
      JOIN public.reward_campaigns c ON c.id = r.campaign_id
      JOIN public.reward_settlements s ON s.id = r.settlement_id
      LEFT JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      WHERE b.source_type IS DISTINCT FROM 'poll_reward_campaign'
         OR r.settlement_id IS DISTINCT FROM c.settlement_id
         OR r.settlement_id IS DISTINCT FROM b.settlement_id
         OR lower(trim(r.creator_wallet)) IS DISTINCT FROM lower(trim(s.refund_recipient_wallet));
    `)).toBe(0);

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      JOIN public.reward_campaigns c ON c.id = v.campaign_id
      JOIN public.reward_settlements s ON s.id = v.settlement_id
      LEFT JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      WHERE b.source_type IS DISTINCT FROM 'poll_reward_campaign'
         OR v.settlement_id IS DISTINCT FROM c.settlement_id
         OR v.settlement_id IS DISTINCT FROM b.settlement_id
         OR lower(trim(s.owner_wallet)) IS DISTINCT FROM lower(trim(c.creator_wallet));
    `)).toBe(0);
  });

  it("indexes each child by settlement and keeps one vault per settlement", () => {
    expect(psql(`
       SELECT tablename || ':' || indexname || ':' || ix.indisunique
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.indexname
      JOIN pg_index ix ON ix.indexrelid = c.oid
      WHERE schemaname = 'public'
        AND indexname IN (
         'idx_reward_funding_settlement', 'idx_reward_receipts_settlement',
         'idx_reward_refunds_settlement'
        )
      ORDER BY tablename;
    `).split("\n")).toEqual([
      "reward_funding_transactions:idx_reward_funding_settlement:false",
      "reward_receipts:idx_reward_receipts_settlement:false",
      "reward_refunds:idx_reward_refunds_settlement:false",
    ]);
    expect(count(`
      SELECT COUNT(*)
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'reward_campaign_vaults'
        AND c.conname = 'reward_campaign_vaults_pkey'
        AND c.contype = 'p';
    `)).toBe(1);

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults
      GROUP BY settlement_id
      HAVING COUNT(*) > 1;
    `)).toBe(0);
  });

  it("keeps payout attempts reached through receipts", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_payout_attempts p
      JOIN public.reward_receipts r ON r.id = p.receipt_id
      WHERE r.settlement_id IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reward_payout_attempts'
        AND column_name = 'settlement_id';
    `)).toBe(0);
  });

  it("rejects financial children rewritten to another settlement", async () => {
    const first = trackFixture(await createPollCampaignFixture(admin));
    const second = trackFixture(await createPollCampaignFixture(admin));
    expect(second.campaignId).not.toBe(first.campaignId);

    const fundingAddress = wallet();
    const { error: fundingError } = await admin.from("reward_funding_transactions").insert({
      campaign_id: first.campaignId,
      settlement_id: first.campaignId,
      creator_wallet: first.creatorWallet,
      funder_wallet: fundingAddress,
      reference: randomUUID(),
      amount_luna: 100,
      status: "submitted",
    });
    if (fundingError) throw fundingError;

    const { error: receiptError } = await admin.from("reward_receipts").insert({
      campaign_id: first.campaignId,
      settlement_id: first.campaignId,
      poll_id: first.pollId,
      participant_wallet: wallet(),
      amount_luna: 1000,
      status: "eligible",
    });
    if (receiptError) throw receiptError;

    const { error: refundError } = await admin.from("reward_refunds").insert({
      campaign_id: first.campaignId,
      settlement_id: first.campaignId,
      creator_wallet: first.creatorWallet,
      amount_luna: 100,
      status: "pending",
    });
    if (refundError) throw refundError;

    const vaultAddress = randomBytes(20).toString("hex");
    const { error: vaultError } = await admin.from("reward_campaign_vaults").insert({
      campaign_id: first.campaignId,
      settlement_id: first.campaignId,
      vault_address_hex: vaultAddress,
      envelope_version: "votum:reward-vault:v1",
      encryption_algorithm: "aes-256-gcm",
      encrypted_private_key_ciphertext: "fixture-ciphertext",
      encryption_iv: "fixture-iv",
      authentication_tag: "fixture-tag",
    });
    if (vaultError) throw vaultError;

    for (const table of [
      "reward_funding_transactions",
      "reward_receipts",
      "reward_refunds",
      "reward_campaign_vaults",
    ]) {
      const childKey = table === "reward_campaign_vaults" ? "campaign_id" : "id";
      const [childId, otherSettlementId] = psql(`
        SELECT child.${childKey} || ':' || other.id
        FROM public.${table} child
        JOIN public.reward_campaigns c ON c.id = child.campaign_id
        JOIN public.reward_settlements other ON other.id <> c.settlement_id
        WHERE c.settlement_id IS NOT NULL
        LIMIT 1;
      `).split(":");
      expect(childId).toBeTruthy();
      expect(otherSettlementId).toBeTruthy();
      expect(() => psql(`
        UPDATE public.${table}
        SET settlement_id = '${otherSettlementId}'
        WHERE ${childKey} = '${childId}';
      `)).toThrow();
    }
  });
});
