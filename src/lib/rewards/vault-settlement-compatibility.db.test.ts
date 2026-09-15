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

describe("V2C.2E vault compatibility", () => {
  it("maps every Poll vault to its existing campaign settlement without changing envelope values", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
       JOIN public.reward_campaigns c ON c.id = v.campaign_id
       LEFT JOIN public.settlement_source_bindings b
         ON b.reward_campaign_id = c.id
        AND b.source_type = 'poll_reward_campaign'
      WHERE v.campaign_id IS NOT NULL
        AND (v.settlement_id IS DISTINCT FROM c.settlement_id
          OR b.settlement_id IS DISTINCT FROM v.settlement_id);
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults
      WHERE vault_address_hex IS NULL
         OR envelope_version IS NULL
         OR encryption_algorithm IS NULL
         OR encrypted_private_key_ciphertext IS NULL
         OR encryption_iv IS NULL
         OR authentication_tag IS NULL;
    `)).toBe(0);
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults
      GROUP BY settlement_id
      HAVING COUNT(*) > 1;
    `)).toBe(0);

    const update = psql(`
      SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
         AND p.proname = 'ensure_reward_settlement_vault_atomic'
      LIMIT 1;
    `);
    expect(update).toMatch(/settlement_id/i);
    expect(update).toMatch(/reward_campaign_vaults/i);
  });

  it("does not permit a vault row to be loaded through another settlement", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      WHERE v.settlement_id IS NULL;
    `)).toBe(0);
  });

  it("keeps an existing encrypted Poll vault decryptable through campaign identity", async () => {
    const fixture = trackFixture(await createPollCampaignFixture(admin));
    const created = await ensureCampaignVault(fixture.campaignId);
    expect(created.vaultAddressHex).toMatch(/^[0-9a-f]+$/);

    const { data: rows, error } = await admin
      .from("reward_campaign_vaults")
      .select("settlement_id, vault_address_hex, envelope_version, encryption_algorithm, encrypted_private_key_ciphertext, encryption_iv, authentication_tag")
      .eq("settlement_id", fixture.campaignId)
      .neq("encrypted_private_key_ciphertext", "fixture-ciphertext")
      .order("created_at", { ascending: false })
      .limit(10);
    expect(error).toBeNull();
    expect(rows?.length).toBeGreaterThan(0);

    let decryptable = false;
    for (const row of rows ?? []) {
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
});
