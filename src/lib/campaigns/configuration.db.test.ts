import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import {
  createParticipationCampaign,
  loadCampaignFundingReadiness,
  publishParticipationCampaign,
  updateParticipationCampaignDraft,
} from "@/lib/campaigns/configuration";

const OWNER = "01" + "c".repeat(38);
const OTHER_OWNER = "01" + "d".repeat(38);
const FUNDER = "01" + "e".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function psql(sql: string): string {
  assertLocalSupabaseForTests();
  return execFileSync("docker", [
    "exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    type: "public_giveaway",
    title: "Configuration integration campaign",
    description: "A creator-owned configuration fixture.",
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
    ...overrides,
  };
}

async function createCampaign(overrides: Record<string, unknown> = {}) {
  const result = await createParticipationCampaign(OWNER, createInput(overrides));
  expect(result.campaign.campaignId).toBeTruthy();
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
  expect(createAdminClient()).not.toBeNull();
});

afterAll(() => {
  if (createdCampaignIds.length === 0) return;
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  psql(`
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
});

describe("V2C.2D Campaign configuration boundary", () => {
  it("creates a server-owned draft with one root and no Poll financial row", async () => {
    const result = await createCampaign();
    const admin = createAdminClient();
    if (!admin) throw new Error("admin unavailable");

    const { data: root } = await admin.from("reward_settlements")
      .select("owner_wallet, funding_wallet, refund_recipient_wallet, status, reward_per_participant_luna, max_rewarded_participants, reward_principal_luna, fee_reserve_luna, total_budget_luna, first_reservation_at")
      .eq("id", result.campaign.settlementId)
      .single();
    expect(root).toMatchObject({
      owner_wallet: OWNER,
      funding_wallet: OWNER,
      refund_recipient_wallet: OWNER,
      status: "configured",
      reward_per_participant_luna: 50000,
      max_rewarded_participants: 10,
      reward_principal_luna: 500000,
      fee_reserve_luna: 80000,
      total_budget_luna: 580000,
      first_reservation_at: null,
    });
    expect(Number(psql(`SELECT COUNT(*) FROM public.reward_campaigns WHERE id = '${result.campaign.campaignId}';`))).toBe(0);
    expect(Number(psql(`SELECT COUNT(*) FROM public.settlement_source_bindings WHERE settlement_id = '${result.campaign.settlementId}' AND source_type = 'participation_campaign' AND participation_campaign_id = '${result.campaign.campaignId}' AND reward_campaign_id IS NULL;`))).toBe(1);
    expect(Number(psql(`SELECT COUNT(*) FROM public.reward_funding_transactions WHERE settlement_id = '${result.campaign.settlementId}';`))).toBe(0);
    expect(Number(psql(`SELECT COUNT(*) FROM public.reward_receipts WHERE settlement_id = '${result.campaign.settlementId}';`))).toBe(0);
  });

  it("configures community funding without changing refund policy", async () => {
    const result = await createCampaign({ fundingMode: "community", fundingWallet: FUNDER.toUpperCase() });
    const admin = createAdminClient();
    if (!admin) throw new Error("admin unavailable");

    const updated = await updateParticipationCampaignDraft(
      OWNER,
      result.campaign.campaignId,
      { fundingMode: "community", fundingWallet: FUNDER, rewardPerParticipant: "1", maxRewardedParticipants: 20 },
    );
    expect(updated.campaign.fundingWallet).toBe(FUNDER);
    const { data: root } = await admin.from("reward_settlements")
      .select("funding_mode, funding_wallet, refund_recipient_wallet, reward_per_participant_luna, max_rewarded_participants, reward_principal_luna, fee_reserve_luna, total_budget_luna")
      .eq("id", result.campaign.settlementId)
      .single();
    expect(root).toMatchObject({
      funding_mode: "community",
      funding_wallet: FUNDER,
      refund_recipient_wallet: OWNER,
      reward_per_participant_luna: 100000,
      max_rewarded_participants: 20,
      reward_principal_luna: 2000000,
      fee_reserve_luna: 160000,
      total_budget_luna: 2160000,
    });
  });

  it("rejects non-owner mutation and client-authoritative identity fields", async () => {
    const result = await createCampaign();
    await expect(updateParticipationCampaignDraft(
      OTHER_OWNER,
      result.campaign.campaignId,
      { title: "Should fail" },
    )).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateParticipationCampaignDraft(
      OWNER,
      result.campaign.campaignId,
      { settlementId: "forged" } as Record<string, unknown>,
    )).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("allows draft edits, then freezes product configuration on publish", async () => {
    const result = await createCampaign();
    const updated = await updateParticipationCampaignDraft(
      OWNER,
      result.campaign.campaignId,
      { title: "Updated creator campaign", visibility: "public" },
    );
    expect(updated.campaign.title).toBe("Updated creator campaign");
    expect(updated.campaign.configurationVersion).toBe(2);

    const published = await publishParticipationCampaign(OWNER, result.campaign.campaignId);
    expect(published.campaign.status).toBe("published");
    expect(published.campaign.publishedConfigurationVersion).toBe(2);
    expect(JSON.stringify(published)).not.toContain("claimable");

    await expect(updateParticipationCampaignDraft(
      OWNER,
      result.campaign.campaignId,
      { title: "Cannot change after publication" },
    )).rejects.toMatchObject({ code: "immutable" });
  });

  it("reports pre-E readiness conservatively without creating a vault or funding intent", async () => {
    const result = await createCampaign();
    const readiness = await loadCampaignFundingReadiness(OWNER, result.campaign.campaignId);

    expect(readiness.fundingReadiness).toMatchObject({ ready: false, reason: "vault_not_ready" });
    expect(JSON.stringify(readiness)).not.toContain("claimable");
    expect(JSON.stringify(readiness)).not.toContain("fundingIntent");
    expect(Number(psql(`SELECT COUNT(*) FROM public.reward_campaign_vaults WHERE settlement_id = '${result.campaign.settlementId}';`))).toBe(0);
    expect(Number(psql(`SELECT COUNT(*) FROM public.reward_funding_transactions WHERE settlement_id = '${result.campaign.settlementId}';`))).toBe(0);
  });

  it("keeps unsupported strategy types non-publishable", async () => {
    const result = await createCampaign({ type: "secret_drop" });
    await expect(publishParticipationCampaign(OWNER, result.campaign.campaignId))
      .rejects.toMatchObject({ code: "not_publishable" });
  });
});
