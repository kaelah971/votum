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
  return "03" + seed.toString(16).padStart(2, "0") + "a".repeat(36);
}

/** Independent client per concurrent caller: separate PostgREST connections. */
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

async function openCampaign(maxParticipants: number, endsAt: string | null = null) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Concurrency fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt,
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
    funded_amount_luna: 500000 * maxParticipants,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function issue(campaignId: string, participant: string): Promise<string> {
  const issued = await issueCampaignClaimChallenge(admin as never, {
    campaignId,
    sessionAddress: participant,
  });
  return issued.challengeId;
}

async function claim(
  client: SupabaseClient,
  campaignId: string,
  participant: string,
  challengeId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("claim_campaign_reward_atomic", {
    _campaign_id: campaignId,
    _participant_wallet: participant,
    _challenge_id: challengeId,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, max_rewarded_participants, first_reservation_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function readReceipts(settlementId: string) {
  const { data, error } = await admin.from("reward_receipts")
    .select("id, campaign_id, poll_id, settlement_id, participant_wallet, amount_luna, status")
    .eq("settlement_id", settlementId);
  if (error || !data) throw error ?? new Error("receipt read failed");
  return data;
}

async function consumedStates(challengeIds: string[]): Promise<Array<string | null>> {
  const { data, error } = await admin.from("campaign_claim_challenges")
    .select("id, consumed_at")
    .in("id", challengeIds);
  if (error || !data) throw error ?? new Error("challenge read failed");
  const byId = new Map(data.map((row) => [row.id as string, row.consumed_at as string | null]));
  return challengeIds.map((id) => byId.get(id) ?? null);
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

describe("claim_campaign_reward_atomic under parallel load", () => {
  it("serializes an 8-way same-wallet race into one receipt plus seven replays", async () => {
    const campaign = await openCampaign(10);
    const claimant = wallet(31);
    const challengeIds = await Promise.all(
      Array.from({ length: 8 }, () => issue(campaign.campaignId, claimant)),
    );

    const results = await Promise.all(
      challengeIds.map((challengeId) => claim(freshAdmin(), campaign.campaignId, claimant, challengeId)),
    );
    const kinds = results.map((result) => result.result_kind as string).sort();
    expect(kinds).toEqual(["replay", "replay", "replay", "replay", "replay", "replay", "replay", "reserved"]);

    const receiptIds = new Set(results.map((result) => result.receipt_id as string));
    expect(receiptIds.size).toBe(1);

    const receipts = await readReceipts(campaign.settlementId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      campaign_id: null,
      poll_id: null,
      settlement_id: campaign.settlementId,
      participant_wallet: claimant,
      status: "reserved",
    });
    expect(receipts[0].id).toBe([...receiptIds][0]);

    const settlement = await readSettlement(campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(1);
    expect(settlement.status).toBe("rewarding");
    expect(settlement.first_reservation_at).not.toBeNull();

    // Every presented challenge reached the replay path and was consumed once.
    expect(await consumedStates(challengeIds)).toHaveLength(8);
    for (const consumed of await consumedStates(challengeIds)) {
      expect(consumed).not.toBeNull();
    }
  });

  it("lets exactly one wallet win a final-slot race with no overshoot", async () => {
    const campaign = await openCampaign(2);
    const holder = wallet(32);
    const held = await issue(campaign.campaignId, holder);
    expect(await claim(freshAdmin(), campaign.campaignId, holder, held)).toMatchObject({
      result_kind: "reserved",
    });

    const racers = [wallet(33), wallet(34), wallet(35)];
    const racerChallenges = await Promise.all(
      racers.map((racer) => issue(campaign.campaignId, racer)),
    );
    const results = await Promise.all(
      racers.map((racer, index) => claim(freshAdmin(), campaign.campaignId, racer, racerChallenges[index])),
    );
    const kinds = results.map((result) => result.result_kind as string).sort();
    expect(kinds).toEqual(["no_reward_capacity", "no_reward_capacity", "reserved"]);

    const winnerIndex = results.findIndex((result) => result.result_kind === "reserved");
    const winnerReceipt = results[winnerIndex].receipt_id as string;
    const receipts = await readReceipts(campaign.settlementId);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((row) => row.id as string)).has(winnerReceipt)).toBe(true);
    for (const row of receipts) {
      expect(row.campaign_id).toBeNull();
      expect(row.poll_id).toBeNull();
      expect(row.settlement_id).toBe(campaign.settlementId);
    }

    const settlement = await readSettlement(campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(2);
    expect(settlement.max_rewarded_participants).toBe(2);
    expect(settlement.status).toBe("exhausted");

    // Losers hold no receipt and their challenges stay unconsumed; the
    // winner challenge is consumed; first_reservation_at is untouched by
    // the race (set once by the earlier holder reservation).
    const loserWallets = new Set(racers.filter((_, index) => index !== winnerIndex));
    for (const row of receipts) {
      expect(loserWallets.has(row.participant_wallet as string)).toBe(false);
    }
    const states = await consumedStates(racerChallenges);
    states.forEach((consumed, index) => {
      if (index === winnerIndex) expect(consumed).not.toBeNull();
      else expect(consumed).toBeNull();
    });
  });

  it("resolves a claim-vs-expiry race to exactly one valid serialization", async () => {
    // Deterministic half: a claim the transaction sees as ended fails with
    // zero writes and an unconsumed challenge.
    const ended = await openCampaign(10, new Date(Date.now() - 60_000).toISOString());
    const late = wallet(36);
    const lateChallenge = await issue(ended.campaignId, late);
    expect(await claim(freshAdmin(), ended.campaignId, late, lateChallenge)).toMatchObject({
      result_kind: "claim_ended",
    });
    expect(await readReceipts(ended.settlementId)).toHaveLength(0);
    expect((await readSettlement(ended.settlementId)).rewarded_participant_count).toBe(0);
    expect(await consumedStates([lateChallenge])).toEqual([null]);

    // Genuine race: claim vs lifecycle close. Either serialization is valid,
    // partial states never are.
    for (let round = 0; round < 3; round += 1) {
      const campaign = await openCampaign(10);
      const claimant = wallet(40 + round);
      const challengeId = await issue(campaign.campaignId, claimant);
      const [outcome] = await Promise.all([
        claim(freshAdmin(), campaign.campaignId, claimant, challengeId),
        (async () => {
          await admin.from("participation_campaigns")
            .update({ status: "expired" })
            .eq("id", campaign.campaignId);
          return { result_kind: "close_applied" };
        })(),
      ]);
      if (outcome.result_kind === "reserved") {
        const receipts = await readReceipts(campaign.settlementId);
        expect(receipts).toHaveLength(1);
        expect(receipts[0].participant_wallet).toBe(claimant);
        expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
        expect(await consumedStates([challengeId])).not.toEqual([null]);
      } else {
        expect(outcome.result_kind).toBe("claim_ended");
        expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
        expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(0);
        expect(await consumedStates([challengeId])).toEqual([null]);
      }
    }
  });

  it("replays concurrent fresh-challenge retries without moving capacity", async () => {
    const campaign = await openCampaign(10);
    const claimant = wallet(50);
    const first = await issue(campaign.campaignId, claimant);
    const reserved = await claim(freshAdmin(), campaign.campaignId, claimant, first);
    expect(reserved.result_kind).toBe("reserved");
    const receiptId = reserved.receipt_id as string;

    const freshIds = await Promise.all(
      Array.from({ length: 4 }, () => issue(campaign.campaignId, claimant)),
    );
    const results = await Promise.all(
      freshIds.map((challengeId) => claim(freshAdmin(), campaign.campaignId, claimant, challengeId)),
    );
    for (const result of results) {
      expect(result).toMatchObject({ result_kind: "replay", receipt_id: receiptId });
    }
    expect(await readReceipts(campaign.settlementId)).toHaveLength(1);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
    for (const consumed of await consumedStates(freshIds)) {
      expect(consumed).not.toBeNull();
    }
  });
});
