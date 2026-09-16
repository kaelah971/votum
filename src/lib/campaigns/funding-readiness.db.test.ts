import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  createParticipationCampaign,
  loadCampaignFundingReadiness,
  publishParticipationCampaign,
} from "@/lib/campaigns/configuration";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
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
  return Number(execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim());
}

async function createCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Funding readiness derivation fixture",
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

async function markFunded(settlementId: string, amountLuna: number): Promise<void> {
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: amountLuna,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", settlementId);
  if (error) throw error;
}

function receiptCount(settlementId: string): number {
  return count(
    `SELECT COUNT(*) FROM public.reward_receipts WHERE settlement_id = '${settlementId}';`,
  );
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

describe("V2C.3A derived funding readiness keeps publication, funding, and claimability distinct", () => {
  it("reports draft plus unfunded without vault as not ready", async () => {
    const campaign = await createCampaign();
    const readiness = await loadCampaignFundingReadiness(OWNER, campaign.campaignId);

    expect(readiness.fundingReadiness).toMatchObject({
      ready: false,
      reason: "vault_not_ready",
      settlementStatus: "configured",
      fundedAmountLuna: "0",
      requiredAmountLuna: "580000",
      vaultReady: false,
    });
    expect(JSON.stringify(readiness)).not.toContain("claimable");
    expect(receiptCount(campaign.settlementId)).toBe(0);
  });

  it("reports vault presence while configured without conflating funding", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    const readiness = await loadCampaignFundingReadiness(OWNER, campaign.campaignId);

    expect(readiness.fundingReadiness).toMatchObject({
      ready: false,
      reason: "ready_for_funding",
      settlementStatus: "configured",
      fundedAmountLuna: "0",
      requiredAmountLuna: "580000",
      vaultReady: true,
    });
    expect(receiptCount(campaign.settlementId)).toBe(0);
  });

  it("reports a funded draft as ready while staying non-claimable: funded does not imply published", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    await markFunded(campaign.settlementId, 580000);
    const readiness = await loadCampaignFundingReadiness(OWNER, campaign.campaignId);

    expect(readiness.campaign.status).toBe("draft");
    expect(readiness.fundingReadiness).toMatchObject({
      ready: true,
      settlementStatus: "funded",
      fundedAmountLuna: "580000",
      requiredAmountLuna: "580000",
      vaultReady: true,
    });
    expect(JSON.stringify(readiness)).not.toContain("claimable");
    expect(receiptCount(campaign.settlementId)).toBe(0);
  });

  it("reports published plus unfunded as not ready: published does not imply funded", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    await publishParticipationCampaign(OWNER, campaign.campaignId);
    const readiness = await loadCampaignFundingReadiness(OWNER, campaign.campaignId);

    expect(readiness.campaign.status).toBe("published");
    expect(readiness.fundingReadiness).toMatchObject({
      ready: false,
      settlementStatus: "configured",
      fundedAmountLuna: "0",
      requiredAmountLuna: "580000",
      vaultReady: true,
    });
    expect(receiptCount(campaign.settlementId)).toBe(0);
  });

  it("derives amounts from authoritative settlement state, never the browser", async () => {
    const campaign = await createCampaign();
    await ensureRewardSettlementVault(campaign.settlementId);
    const readiness = await loadCampaignFundingReadiness(OWNER, campaign.campaignId);

    const { data: root } = await admin.from("reward_settlements")
      .select("total_budget_luna, funded_amount_luna, max_rewarded_participants, rewarded_participant_count")
      .eq("id", campaign.settlementId)
      .single();
    expect(readiness.fundingReadiness.requiredAmountLuna).toBe(String(root?.total_budget_luna));
    expect(readiness.fundingReadiness.fundedAmountLuna).toBe(String(root?.funded_amount_luna));
    expect(readiness.campaign.reward.maxRewardedParticipants).toBe(root?.max_rewarded_participants);
    expect(Number(root?.max_rewarded_participants) - Number(root?.rewarded_participant_count)).toBe(10);
  });

  it("exposes no receipt, challenge, or claim route for the Campaign", async () => {
    // Filesystem absence proof: the claim route file must not exist in
    // slice A. Task D4 retires this probe when the route lands (the
    // assertion fails once the file exists).
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(
      existsSync(join(process.cwd(), "src", "app", "api", "campaigns", "[campaignId]", "claims", "route.ts")),
    ).toBe(false);
  });
});
