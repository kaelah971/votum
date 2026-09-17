import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
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

function wallet(seed: number): string {
  return "04" + seed.toString(16).padStart(2, "0") + "a".repeat(36);
}

function freshAdmin(): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "public" },
  });
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

async function openCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Claim-close race fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 500000,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function claim(client: SupabaseClient, campaignId: string, participant: string, challengeId: string) {
  const { data, error } = await client.rpc("claim_campaign_reward_atomic", {
    _campaign_id: campaignId,
    _participant_wallet: participant,
    _challenge_id: challengeId,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function close(client: SupabaseClient, campaignId: string) {
  const { data, error } = await client.rpc("close_participation_campaign_atomic", {
    _campaign_id: campaignId,
    _owner_wallet: OWNER,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function readState(campaignId: string, settlementId: string) {
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
  const { data: receipts, error: receiptError } = await admin.from("reward_receipts")
    .select("id, participant_wallet, status")
    .eq("settlement_id", settlementId);
  if (receiptError) throw receiptError;
  return { campaign, settlement, receipts: receipts ?? [] };
}

async function consumedAt(challengeId: string): Promise<string | null> {
  const { data } = await admin.from("campaign_claim_challenges")
    .select("consumed_at").eq("id", challengeId).single();
  return (data?.consumed_at as string | null) ?? null;
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

describe("claim vs close serialization on the shared settlement lock", () => {
  it("preserves a committed claim when close commits second", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(91);
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    const claimed = await claim(freshAdmin(), campaign.campaignId, claimant, issued.challengeId);
    expect(claimed.result_kind).toBe("reserved");

    const closed = await close(freshAdmin(), campaign.campaignId);
    expect(closed.result_kind).toBe("closed");

    const state = await readState(campaign.campaignId, campaign.settlementId);
    expect(state.campaign).toMatchObject({ status: "closed", close_reason: "creator_cancelled" });
    expect(state.settlement.status).toBe("closed");
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({ participant_wallet: claimant, status: "reserved" });
    expect(state.settlement.rewarded_participant_count).toBe(1);
    expect(state.settlement.first_reservation_at).not.toBeNull();
    expect(await consumedAt(issued.challengeId)).not.toBeNull();
  });

  it("rejects a claim when close commits first with zero writes", async () => {
    const campaign = await openCampaign();
    const closed = await close(freshAdmin(), campaign.campaignId);
    expect(closed.result_kind).toBe("closed");

    const claimant = wallet(92);
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    const rejected = await claim(freshAdmin(), campaign.campaignId, claimant, issued.challengeId);
    expect(rejected.result_kind).toBe("campaign_closed");

    const state = await readState(campaign.campaignId, campaign.settlementId);
    expect(state.receipts).toHaveLength(0);
    expect(state.settlement.rewarded_participant_count).toBe(0);
    expect(state.settlement.first_reservation_at).toBeNull();
    expect(await consumedAt(issued.challengeId)).toBeNull();
  });

  it("resolves genuine claim-vs-close overlap to exactly one valid serialization", async () => {
    for (let round = 0; round < 5; round += 1) {
      const campaign = await openCampaign();
      const claimant = wallet(100 + round);
      const issued = await issueCampaignClaimChallenge(admin as never, {
        campaignId: campaign.campaignId,
        sessionAddress: claimant,
      });
      const [outcome] = await Promise.all([
        claim(freshAdmin(), campaign.campaignId, claimant, issued.challengeId),
        close(freshAdmin(), campaign.campaignId),
      ]);
      // The racing close may win, lose, or serialize either way; both
      // outcomes below are valid, partial states never are.
      if (outcome.result_kind === "reserved") {
        const closed = await close(freshAdmin(), campaign.campaignId);
        expect(["closed", "replay"]).toContain(closed.result_kind);
        const state = await readState(campaign.campaignId, campaign.settlementId);
        expect(state.campaign.status).toBe("closed");
        expect(state.settlement.status).toBe("closed");
        expect(state.receipts).toHaveLength(1);
        expect(state.receipts[0].participant_wallet).toBe(claimant);
        expect(state.settlement.rewarded_participant_count).toBe(1);
        expect(await consumedAt(issued.challengeId)).not.toBeNull();
      } else {
        // Close serialized first: the authoritative settlement state is
        // closed, so the claim deterministically reports campaign_closed
        // even when it read the product row before the close committed.
        // Anything else (including a torn receipt) fails below.
        expect(outcome.result_kind).toBe("campaign_closed");
        const state = await readState(campaign.campaignId, campaign.settlementId);
        expect(state.receipts).toHaveLength(0);
        expect(state.settlement.rewarded_participant_count).toBe(0);
        expect(state.settlement.first_reservation_at).toBeNull();
        expect(await consumedAt(issued.challengeId)).toBeNull();
      }
    }
  });
});
