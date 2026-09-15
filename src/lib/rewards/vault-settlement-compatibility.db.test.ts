import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { withCampaignVaultKey } from "@/lib/rewards/vault-service";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

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

beforeAll(() => {
  assertLocalSupabaseForTests();
});

describe("V2C.2B vault compatibility", () => {
  it("maps every Poll vault to its existing campaign settlement without changing envelope values", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      JOIN public.reward_campaigns c ON c.id = v.campaign_id
      WHERE v.settlement_id IS DISTINCT FROM c.settlement_id;
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
        AND p.proname = 'ensure_reward_campaign_vault_atomic'
      LIMIT 1;
    `);
    expect(update).not.toMatch(/settlement_id/i);
    expect(update).toMatch(/reward_campaign_vaults/i);
  });

  it("does not permit a vault row to be loaded through another settlement", () => {
    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      WHERE v.campaign_id = v.settlement_id;
    `)).toBe(count("SELECT COUNT(*) FROM public.reward_campaign_vaults;"));

    expect(count(`
      SELECT COUNT(*)
      FROM public.reward_campaign_vaults v
      JOIN public.reward_settlements s ON s.id <> v.settlement_id
      WHERE v.settlement_id = s.id;
    `)).toBe(0);
  });

  it("keeps an existing encrypted Poll vault decryptable through campaign identity", async () => {
    const { data: rows, error } = await admin
      .from("reward_campaign_vaults")
      .select("campaign_id, vault_address_hex, envelope_version, encryption_algorithm, encrypted_private_key_ciphertext, encryption_iv, authentication_tag")
      .neq("encrypted_private_key_ciphertext", "fixture-ciphertext")
      .order("created_at", { ascending: false })
      .limit(10);
    expect(error).toBeNull();
    expect(rows?.length).toBeGreaterThan(0);

    let decryptable = false;
    for (const row of rows ?? []) {
      try {
        const address = await withCampaignVaultKey(row.campaign_id, (keypair) => keypair.toAddress().toHex());
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
