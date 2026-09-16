import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  createParticipationCampaign,
  loadCampaignFundingReadiness,
  publishParticipationCampaign,
} from "@/lib/campaigns/configuration";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { getPublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";
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

async function createCampaign(overrides: Record<string, unknown> = {}) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Public projector fixture",
    description: "Share-link read fixture.",
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
    ...overrides,
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result.campaign;
}

async function markFunded(settlementId: string): Promise<void> {
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 580000,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", settlementId);
  if (error) throw error;
}

async function closeProduct(campaignId: string): Promise<void> {
  const { error } = await admin.from("participation_campaigns").update({
    status: "closed",
    close_reason: "creator_cancelled",
    closed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", campaignId);
  if (error) throw error;
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

describe("V2C.3B public projector on authoritative settlement truth", () => {
  it("returns null for unknown, draft, private, cancelled, and non-giveaway Campaigns", async () => {
    await expect(
      getPublicCampaignGiveaway(admin as never, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeNull();

    const draft = await createCampaign();
    await expect(getPublicCampaignGiveaway(admin as never, draft.campaignId)).resolves.toBeNull();

    const secret = await createCampaign({ type: "secret_drop", title: "Secret" });
    await expect(getPublicCampaignGiveaway(admin as never, secret.campaignId)).resolves.toBeNull();

    const priv = await createCampaign({ visibility: "private", title: "Private" });
    await expect(getPublicCampaignGiveaway(admin as never, priv.campaignId)).resolves.toBeNull();
  });

  it("projects published-but-unfunded Campaigns with exact zero-reservation counts", async () => {
    const campaign = await createCampaign();
    await publishParticipationCampaign(OWNER, campaign.campaignId);

    const dto = await getPublicCampaignGiveaway(admin as never, campaign.campaignId);
    expect(dto).toMatchObject({
      campaignId: campaign.campaignId,
      campaignType: "public_giveaway",
      visibility: "public",
      title: "Public projector fixture",
      claimState: "needs_funding",
      published: true,
      fundingReady: false,
      maxRewardedParticipants: 10,
      remainingRewards: 10,
      reservedCount: 0,
      paidCount: 0,
    });
    expect(typeof dto?.rewardPerParticipantNim).toBe("string");

    const { data: root } = await admin.from("reward_settlements")
      .select("reward_per_participant_luna, max_rewarded_participants, rewarded_participant_count")
      .eq("id", campaign.settlementId)
      .single();
    expect(dto?.remainingRewards).toBe(
      Number(root?.max_rewarded_participants) - Number(root?.rewarded_participant_count),
    );
  });

  it("projects starts_soon, open, ended, and closed from live rows", async () => {
    const future = await createCampaign({ title: "Future", startsAt: "2026-09-17T12:00:00.000Z" });
    await ensureRewardSettlementVault(future.settlementId);
    await publishParticipationCampaign(OWNER, future.campaignId);
    await markFunded(future.settlementId);
    await expect(getPublicCampaignGiveaway(admin as never, future.campaignId)).resolves.toMatchObject({
      claimState: "starts_soon",
      fundingReady: true,
    });

    const open = await createCampaign({ title: "Open now" });
    await ensureRewardSettlementVault(open.settlementId);
    await publishParticipationCampaign(OWNER, open.campaignId);
    await markFunded(open.settlementId);
    await expect(getPublicCampaignGiveaway(admin as never, open.campaignId)).resolves.toMatchObject({
      claimState: "open",
      published: true,
      fundingReady: true,
      remainingRewards: 10,
    });

    const ended = await createCampaign({ title: "Ended", endsAt: "2026-09-15T12:00:00.000Z" });
    await ensureRewardSettlementVault(ended.settlementId);
    await publishParticipationCampaign(OWNER, ended.campaignId);
    await markFunded(ended.settlementId);
    await expect(getPublicCampaignGiveaway(admin as never, ended.campaignId)).resolves.toMatchObject({
      claimState: "ended",
    });

    const closed = await createCampaign({ title: "Closed" });
    await ensureRewardSettlementVault(closed.settlementId);
    await publishParticipationCampaign(OWNER, closed.campaignId);
    await markFunded(closed.settlementId);
    await closeProduct(closed.campaignId);
    await expect(getPublicCampaignGiveaway(admin as never, closed.campaignId)).resolves.toMatchObject({
      claimState: "closed",
      published: false,
    });
  });

  it("agrees with funding readiness on the same authoritative rows", async () => {
    const campaign = await createCampaign({ title: "Agreement" });
    await ensureRewardSettlementVault(campaign.settlementId);
    await publishParticipationCampaign(OWNER, campaign.campaignId);
    await markFunded(campaign.settlementId);

    const [dto, readiness] = await Promise.all([
      getPublicCampaignGiveaway(admin as never, campaign.campaignId),
      loadCampaignFundingReadiness(OWNER, campaign.campaignId),
    ]);
    expect(dto?.fundingReady).toBe(true);
    expect(readiness.fundingReadiness.ready).toBe(true);
    expect(dto?.remainingRewards).toBe(10);
  });

  it("exposes no private material to the anon role", async () => {
    const publishable =
      process.env.VOTUM_CLEANROOM_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      "invalid";
    const anon = createClient(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "public" },
    });
    for (const table of ["reward_settlements", "reward_receipts", "reward_campaign_vaults"] as const) {
      const { data } = await anon.from(table).select("id").limit(1);
      expect(data ?? []).toEqual([]);
    }
  });
});
