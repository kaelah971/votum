import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign } from "@/lib/campaigns/configuration";
import {
  ensureRewardSettlementVault,
  getRewardSettlementVault,
  withRewardSettlementVaultKey,
} from "@/lib/rewards/vault-service";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function count(sql: string): number {
  const output = execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
  return Number(output);
}

async function createCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Standalone vault proof campaign",
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

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
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

describe("V2C.3A standalone Campaign settlement vault", () => {
  it("provisions exactly one vault keyed by settlement_id with campaign_id NULL", async () => {
    const campaign = await createCampaign();

    const created = await ensureRewardSettlementVault(campaign.settlementId);
    expect(created.created).toBe(true);
    expect(created.settlementId).toBe(campaign.settlementId);
    expect(created.campaignId).toBeNull();
    expect(created.vaultAddressHex).toMatch(/^[0-9a-f]{40}$/);
    expect(created.vaultAddressNq).toMatch(/^NQ/);

    expect(count(
      `SELECT COUNT(*) FROM public.reward_campaign_vaults WHERE settlement_id = '${campaign.settlementId}';`,
    )).toBe(1);
    expect(count(
      `SELECT COUNT(*) FROM public.reward_campaign_vaults WHERE settlement_id = '${campaign.settlementId}' AND campaign_id IS NULL;`,
    )).toBe(1);
  });

  it("creates no reward_campaigns row and keeps the Campaign source binding", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);

    expect(count(
      `SELECT COUNT(*) FROM public.reward_campaigns WHERE id = '${campaign.campaignId}';`,
    )).toBe(0);
    expect(count(
      `SELECT COUNT(*) FROM public.settlement_source_bindings WHERE settlement_id = '${campaign.settlementId}' AND source_type = 'participation_campaign' AND participation_campaign_id = '${campaign.campaignId}' AND reward_campaign_id IS NULL;`,
    )).toBe(1);
    const { data: root } = await admin.from("reward_settlements")
      .select("owner_wallet")
      .eq("id", campaign.settlementId)
      .single();
    expect(root?.owner_wallet).toBe(OWNER);
  });

  it("is idempotent and never exposes private vault material", async () => {
    const campaign = await createCampaign();
    const first = await ensureRewardSettlementVault(campaign.settlementId);
    const second = await ensureRewardSettlementVault(campaign.settlementId);

    expect(second.created).toBe(false);
    expect(second.vaultAddressHex).toBe(first.vaultAddressHex);
    expect(count(
      `SELECT COUNT(*) FROM public.reward_campaign_vaults WHERE settlement_id = '${campaign.settlementId}';`,
    )).toBe(1);

    const read = await getRewardSettlementVault(campaign.settlementId);
    expect(Object.keys(read ?? {}).sort()).toEqual(
      ["campaignId", "created", "settlementId", "vaultAddressHex", "vaultAddressNq"].sort(),
    );
    expect(JSON.stringify(read)).not.toContain("ciphertext");
    expect(JSON.stringify(read)).not.toContain("private");
  });

  it("decrypts through the unchanged envelope without re-encryption", async () => {
    const campaign = await createCampaign();
    const created = await ensureRewardSettlementVault(campaign.settlementId);

    const derived = await withRewardSettlementVaultKey(campaign.settlementId, (keypair) =>
      keypair.toAddress().toHex(),
    );
    expect(derived.toLowerCase()).toBe(created.vaultAddressHex.toLowerCase());

    const again = await ensureRewardSettlementVault(campaign.settlementId);
    expect(again.created).toBe(false);
    expect(again.vaultAddressHex).toBe(created.vaultAddressHex);
  });

  it("refuses unknown settlements and post-funding states", async () => {
    await expect(
      ensureRewardSettlementVault("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("settlement_not_found");

    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    runPsql(`UPDATE public.reward_settlements SET status = 'funded' WHERE id = '${campaign.settlementId}';`);
    await expect(ensureRewardSettlementVault(campaign.settlementId)).rejects.toThrow(
      "settlement_state_invalid",
    );
  });
});
