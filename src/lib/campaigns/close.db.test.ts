import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { closeParticipationCampaign } from "@/lib/campaigns/close";
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
const OTHER = "02" + "b".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function wallet(seed: number): string {
  return "03" + seed.toString(16).padStart(2, "0") + "a".repeat(36);
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

async function openCampaign(maxParticipants = 10) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Close fixture ${hex(4)}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: maxParticipants,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 50000 * maxParticipants,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function readLifecycle(campaignId: string, settlementId: string) {
  const { data: campaign, error: campaignError } = await admin.from("participation_campaigns")
    .select("status, close_reason, closed_at")
    .eq("id", campaignId)
    .single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  const { data: settlement, error: settlementError } = await admin.from("reward_settlements")
    .select("status, closed_at, rewarded_participant_count, first_reservation_at")
    .eq("id", settlementId)
    .single();
  if (settlementError || !settlement) throw settlementError ?? new Error("settlement fixture missing");
  return { campaign, settlement };
}

async function claim(campaignId: string, participant: string) {
  const issued = await issueCampaignClaimChallenge(admin as never, {
    campaignId,
    sessionAddress: participant,
  });
  const { data, error } = await admin.rpc("claim_campaign_reward_atomic", {
    _campaign_id: campaignId,
    _participant_wallet: participant,
    _challenge_id: issued.challengeId,
  });
  if (error) throw error;
  return { issued, result: data as Record<string, unknown> };
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  if (campaigns.length === 0) return;
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE settlement_id IN (${roots}));
    DELETE FROM public.campaign_claim_challenges WHERE campaign_id IN (${campaigns});
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

describe("closeParticipationCampaign against the atomic close RPC", () => {
  it("closes an owned Campaign on product and settlement with one timestamp", async () => {
    const campaign = await openCampaign();
    const result = await closeParticipationCampaign(admin as never, campaign.campaignId, OWNER);
    expect(result).toEqual({ kind: "closed", settlementId: campaign.settlementId });

    const { campaign: product, settlement } = await readLifecycle(campaign.campaignId, campaign.settlementId);
    expect(product).toMatchObject({ status: "closed", close_reason: "creator_cancelled" });
    expect(product.closed_at).not.toBeNull();
    expect(settlement.status).toBe("closed");
    expect(settlement.closed_at).toBe(product.closed_at);

    const { data: refunds } = await admin.from("reward_refunds")
      .select("id").eq("settlement_id", campaign.settlementId);
    expect(refunds ?? []).toHaveLength(0);
  });

  it("replays an already-closed Campaign", async () => {
    const campaign = await openCampaign();
    expect(await closeParticipationCampaign(admin as never, campaign.campaignId, OWNER))
      .toMatchObject({ kind: "closed" });
    expect(await closeParticipationCampaign(admin as never, campaign.campaignId, OWNER))
      .toEqual({ kind: "replay", settlementId: campaign.settlementId });
  });

  it("rejects non-owners, unknown campaigns, and malformed owners without writes", async () => {
    const campaign = await openCampaign();
    await expect(
      closeParticipationCampaign(admin as never, campaign.campaignId, OTHER),
    ).resolves.toEqual({ kind: "error", reasonCode: "forbidden" });
    await expect(
      closeParticipationCampaign(admin as never, campaign.campaignId, "not-a-wallet"),
    ).resolves.toEqual({ kind: "error", reasonCode: "forbidden" });
    await expect(
      closeParticipationCampaign(admin as never, randomUUID(), OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "campaign_not_found" });

    const { campaign: product, settlement } = await readLifecycle(campaign.campaignId, campaign.settlementId);
    expect(product.status).toBe("published");
    expect(settlement.status).toBe("funded");
  });

  it("rejects draft campaigns and non-closable settlement states", async () => {
    const draft = await createParticipationCampaign(OWNER, {
      type: "public_giveaway",
      title: `Draft close fixture ${hex(4)}`,
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(draft.campaign.campaignId);
    createdRootIds.push(draft.campaign.settlementId);
    await expect(
      closeParticipationCampaign(admin as never, draft.campaign.campaignId, OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "invalid_state" });

    const campaign = await openCampaign();
    runPsql(`UPDATE public.reward_settlements SET status = 'refunding' WHERE id = '${campaign.settlementId}';`);
    await expect(
      closeParticipationCampaign(admin as never, campaign.campaignId, OWNER),
    ).resolves.toEqual({ kind: "error", reasonCode: "invalid_state" });
    const { campaign: product } = await readLifecycle(campaign.campaignId, campaign.settlementId);
    expect(product.status).toBe("published");
  });

  it("preserves an existing reservation across close without touching payout state", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(81);
    const { issued, result } = await claim(campaign.campaignId, claimant);
    expect(result.result_kind).toBe("reserved");
    const receiptId = result.receipt_id as string;

    const { data: begun, error: beginError } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    if (beginError) throw beginError;
    expect((begun as Record<string, unknown>).result_kind).toBe("created");

    const closed = await closeParticipationCampaign(admin as never, campaign.campaignId, OWNER);
    expect(closed).toMatchObject({ kind: "closed" });

    const { data: receipt } = await admin.from("reward_receipts")
      .select("status, amount_luna, participant_wallet").eq("id", receiptId).single();
    expect(receipt).toMatchObject({ status: "payout_pending", participant_wallet: claimant });
    const { data: attempts } = await admin.from("reward_payout_attempts")
      .select("id, status").eq("receipt_id", receiptId);
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0].status).toBe("pending");
    const { settlement } = await readLifecycle(campaign.campaignId, campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(1);
    expect(settlement.first_reservation_at).not.toBeNull();

    const { data: challenges } = await admin.from("campaign_claim_challenges")
      .select("consumed_at").eq("id", issued.challengeId).single();
    expect(challenges?.consumed_at).not.toBeNull();
  });

  it("rejects post-close claims with campaign_closed and zero writes", async () => {
    const campaign = await openCampaign();
    await closeParticipationCampaign(admin as never, campaign.campaignId, OWNER);

    const claimant = wallet(82);
    const { result } = await claim(campaign.campaignId, claimant);
    expect(result.result_kind).toBe("campaign_closed");

    const { data: receipts } = await admin.from("reward_receipts")
      .select("id").eq("settlement_id", campaign.settlementId);
    expect(receipts ?? []).toHaveLength(0);
    const { settlement } = await readLifecycle(campaign.campaignId, campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(0);
  });
});
