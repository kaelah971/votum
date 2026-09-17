import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { beginCampaignFunding, bindCampaignFunding } from "@/lib/campaigns/funding";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import {
  createDefaultFundingConfirmationDependencies,
  loadFundingConfirmationContext,
  reconcileFundingIntent,
} from "@/lib/rewards/funding-confirmation";
import type { FundingObservation } from "@/lib/rewards/reconciliation";
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

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function wallet(seed: number): string {
  return "02" + seed.toString(16).padStart(2, "0") + "a".repeat(36);
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function observedFunding(hash: string, vaultHex: string, amountLuna: bigint, reference: string): FundingObservation {
  const block = hex(32);
  return {
    kind: "found",
    transaction: {
      transactionHash: hash,
      blockHash: block,
      networkId: 24,
      sender: OWNER,
      recipient: vaultHex,
      valueLuna: amountLuna,
      memo: reference,
      executionResult: true,
      blockHeight: 100,
      timestampMs: Date.now(),
      confirmationCount: 10,
      finality: "final",
      finalityReason: null,
      finalityEvidence: {
        transactionBlockHeight: 100,
        transactionBlockHash: block,
        canonicalBlockHash: block,
        canonicalBlockVerified: true,
        batchNumber: 1,
        finalizingMacroBlockHeight: 101,
        finalizingMacroBlockHash: hex(32),
      },
    },
  };
}

async function createCampaign(options: {
  type?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  maxParticipants?: number;
  publish?: boolean;
  fund?: boolean;
} = {}) {
  const result = await createParticipationCampaign(OWNER, {
    type: options.type ?? "public_giveaway",
    title: `Claim RPC fixture ${hex(4)}`,
    description: null,
    visibility: "unlisted",
    startsAt: options.startsAt ?? null,
    endsAt: options.endsAt ?? null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: options.maxParticipants ?? 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  if (options.publish === false) return result.campaign;
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  if (options.fund === false) return result.campaign;
  await ensureRewardSettlementVault(result.campaign.settlementId);
  const started = await beginCampaignFunding(admin as never, result.campaign.campaignId, OWNER);
  if (started.kind !== "created") throw new Error(`fund begin failed: ${started.kind}`);
  const txHash = hex(32);
  const bound = await bindCampaignFunding(
    admin as never, result.campaign.campaignId, started.fundingIntent.fundingIntentId, OWNER, txHash,
  );
  if (bound.kind !== "bound") throw new Error(`fund bind failed: ${bound.kind}`);
  const loaded = await loadFundingConfirmationContext(
    admin as never, result.campaign.settlementId, started.fundingIntent.fundingIntentId, OWNER,
  );
  if (loaded.kind !== "ok") throw new Error("fund context not loadable");
  const deps = createDefaultFundingConfirmationDependencies(admin as never);
  const confirmed = await reconcileFundingIntent(loaded.context, {
    ...deps,
    observeFundingByHash: async () => observedFunding(
      txHash, started.fundingIntent.vaultAddressHex, BigInt(started.fundingIntent.requiredFundingLuna), started.fundingIntent.reference,
    ),
  });
  if (confirmed.kind !== "confirmed") throw new Error(`fund confirm failed: ${confirmed.kind}`);
  return result.campaign;
}

async function issue(campaignId: string, participant: string) {
  return issueCampaignClaimChallenge(admin as never, { campaignId, sessionAddress: participant });
}

async function claim(campaignId: string, participant: string, challengeId: string) {
  const { data, error } = await admin.rpc("claim_campaign_reward_atomic", {
    _campaign_id: campaignId,
    _participant_wallet: participant,
    _challenge_id: challengeId,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function readChallenge(challengeId: string) {
  const { data, error } = await admin.from("campaign_claim_challenges")
    .select("consumed_at")
    .eq("id", challengeId)
    .single();
  if (error || !data) throw error ?? new Error("challenge fixture missing");
  return data;
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, max_rewarded_participants, first_reservation_at, reward_per_participant_luna")
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

describe("claim_campaign_reward_atomic", () => {
  it("reserves the first entitlement and consumes the challenge in one commit", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const claimant = wallet(1);
    const issued = await issue(campaign.campaignId, claimant);

    const result = await claim(campaign.campaignId, claimant, issued.challengeId);
    expect(result.result_kind).toBe("reserved");
    expect(result.receipt_id).toBeTruthy();
    expect(result.settlement_id).toBe(campaign.settlementId);
    expect(result.campaign_id).toBe(campaign.campaignId);
    expect(String(result.amount_luna)).toBe("50000");
    expect(result.status).toBe("reserved");
    expect(result.rewards_remaining).toBe(1);

    const receipts = await readReceipts(campaign.settlementId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      campaign_id: null,
      poll_id: null,
      settlement_id: campaign.settlementId,
      participant_wallet: claimant,
      status: "reserved",
    });
    expect(String(receipts[0].amount_luna)).toBe("50000");

    expect((await readChallenge(issued.challengeId)).consumed_at).not.toBeNull();
    const settlement = await readSettlement(campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(1);
    expect(settlement.status).toBe("rewarding");
    expect(settlement.first_reservation_at).not.toBeNull();
  });

  it("replays the same challenge without moving capacity", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const claimant = wallet(2);
    const issued = await issue(campaign.campaignId, claimant);
    const first = await claim(campaign.campaignId, claimant, issued.challengeId);
    expect(first.result_kind).toBe("reserved");

    const replay = await claim(campaign.campaignId, claimant, issued.challengeId);
    expect(replay).toMatchObject({ result_kind: "replay", receipt_id: first.receipt_id });

    const settlement = await readSettlement(campaign.settlementId);
    expect(settlement.rewarded_participant_count).toBe(1);
    expect((await readReceipts(campaign.settlementId))).toHaveLength(1);
  });

  it("replays a fresh challenge for an already-reserved wallet and consumes it", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const claimant = wallet(3);
    const first = await issue(campaign.campaignId, claimant);
    const reserved = await claim(campaign.campaignId, claimant, first.challengeId);
    expect(reserved.result_kind).toBe("reserved");

    const second = await issue(campaign.campaignId, claimant);
    const replay = await claim(campaign.campaignId, claimant, second.challengeId);
    expect(replay).toMatchObject({ result_kind: "replay", receipt_id: reserved.receipt_id });
    expect((await readChallenge(second.challengeId)).consumed_at).not.toBeNull();
    expect((await readReceipts(campaign.settlementId))).toHaveLength(1);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
  });

  it("replays before capacity even when the campaign is exhausted", async () => {
    const campaign = await createCampaign({ maxParticipants: 1 });
    const firstWallet = wallet(4);
    const first = await issue(campaign.campaignId, firstWallet);
    expect(await claim(campaign.campaignId, firstWallet, first.challengeId)).toMatchObject({ result_kind: "reserved" });
    expect((await readSettlement(campaign.settlementId)).status).toBe("exhausted");

    const retry = await issue(campaign.campaignId, firstWallet);
    const replay = await claim(campaign.campaignId, firstWallet, retry.challengeId);
    expect(replay.result_kind).toBe("replay");
    expect((await readReceipts(campaign.settlementId))).toHaveLength(1);
  });

  it("rejects unknown campaigns, challenges, and mismatched bindings without writes", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const claimant = wallet(5);
    const issued = await issue(campaign.campaignId, claimant);

    const missing = await claim(randomUUID(), claimant, issued.challengeId);
    expect(missing.result_kind).toBe("campaign_not_found");

    const unknownChallenge = await claim(campaign.campaignId, claimant, randomUUID());
    expect(unknownChallenge.result_kind).toBe("challenge_invalid");

    const other = await createCampaign({ maxParticipants: 2 });
    const crossCampaign = await claim(other.campaignId, claimant, issued.challengeId);
    expect(crossCampaign.result_kind).toBe("challenge_invalid");

    const crossWallet = await claim(campaign.campaignId, wallet(6), issued.challengeId);
    expect(crossWallet.result_kind).toBe("challenge_invalid");

    expect((await readChallenge(issued.challengeId)).consumed_at).toBeNull();
    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(0);

    // Action/version drift cannot exist at rest: the storage CHECK rejects
    // it, so the RPC's scope recheck is unreachable defense-in-depth. The
    // challenge remains valid afterwards.
    expect(() =>
      runPsql(`UPDATE public.campaign_claim_challenges SET action = 'wallet_verify' WHERE id = '${issued.challengeId}';`),
    ).toThrow();
    expect((await readChallenge(issued.challengeId)).consumed_at).toBeNull();
  });

  it("rejects expired and already-consumed challenges without writes", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const claimant = wallet(7);
    const issued = await issue(campaign.campaignId, claimant);

    runPsql(`UPDATE public.campaign_claim_challenges
      SET issued_at = '${new Date(Date.now() - 10 * 60 * 1000).toISOString()}',
          expires_at = '${new Date(Date.now() - 60_000).toISOString()}'
      WHERE id = '${issued.challengeId}';`);
    const expired = await claim(campaign.campaignId, claimant, issued.challengeId);
    expect(expired.result_kind).toBe("challenge_expired");

    const fresh = await issue(campaign.campaignId, claimant);
    runPsql(`UPDATE public.campaign_claim_challenges
      SET consumed_at = '${new Date().toISOString()}' WHERE id = '${fresh.challengeId}';`);
    const consumed = await claim(campaign.campaignId, claimant, fresh.challengeId);
    expect(consumed.result_kind).toBe("challenge_consumed");

    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(0);
  });

  it("rejects unpublished, not-started, ended, and closed campaigns without writes", async () => {
    const draft = await createCampaign({ publish: false, fund: false });
    const draftChallenge = await issue(draft.campaignId, wallet(8));
    expect(await claim(draft.campaignId, wallet(8), draftChallenge.challengeId)).toMatchObject({
      result_kind: "campaign_not_published",
    });
    expect((await readChallenge(draftChallenge.challengeId)).consumed_at).toBeNull();

    const future = await createCampaign({
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), fund: false,
    });
    const futureChallenge = await issue(future.campaignId, wallet(9));
    expect(await claim(future.campaignId, wallet(9), futureChallenge.challengeId)).toMatchObject({
      result_kind: "claim_not_started",
    });

    const past = await createCampaign({
      endsAt: new Date(Date.now() - 60_000).toISOString(), fund: false,
    });
    const pastChallenge = await issue(past.campaignId, wallet(10));
    expect(await claim(past.campaignId, wallet(10), pastChallenge.challengeId)).toMatchObject({
      result_kind: "claim_ended",
    });

    const closing = await createCampaign({ fund: false });
    runPsql(`UPDATE public.participation_campaigns SET status = 'closed' WHERE id = '${closing.campaignId}';`);
    const closedChallenge = await issue(closing.campaignId, wallet(11));
    expect(await claim(closing.campaignId, wallet(11), closedChallenge.challengeId)).toMatchObject({
      result_kind: "campaign_closed",
    });
    expect((await readChallenge(closedChallenge.challengeId)).consumed_at).toBeNull();
    expect(await readReceipts(closing.settlementId)).toHaveLength(0);
  });

  it("rejects unsupported types and unfunded campaigns without writes", async () => {
    const other = await createCampaign({ type: "secret_drop", publish: false, fund: false });
    const otherChallenge = await issue(other.campaignId, wallet(12));
    expect(await claim(other.campaignId, wallet(12), otherChallenge.challengeId)).toMatchObject({
      result_kind: "unsupported_type",
    });

    const unfunded = await createCampaign({ fund: false });
    const unfundedChallenge = await issue(unfunded.campaignId, wallet(13));
    expect(await claim(unfunded.campaignId, wallet(13), unfundedChallenge.challengeId)).toMatchObject({
      result_kind: "campaign_not_funded",
    });
    expect((await readChallenge(unfundedChallenge.challengeId)).consumed_at).toBeNull();
    expect(await readReceipts(unfunded.settlementId)).toHaveLength(0);
  });

  it("rejects the creator including wallet case variants without writes", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const ownerChallenge = await issue(campaign.campaignId, OWNER);
    expect(await claim(campaign.campaignId, OWNER, ownerChallenge.challengeId)).toMatchObject({
      result_kind: "creator_not_eligible",
    });
    expect((await readChallenge(ownerChallenge.challengeId)).consumed_at).toBeNull();

    const upperWallet = OWNER.toUpperCase();
    const upperChallenge = await issue(campaign.campaignId, upperWallet);
    expect(await claim(campaign.campaignId, upperWallet, upperChallenge.challengeId)).toMatchObject({
      result_kind: "creator_not_eligible",
    });

    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(0);
  });

  it("rejects over-capacity claims while leaving the loser challenge unconsumed", async () => {
    const campaign = await createCampaign({ maxParticipants: 1 });
    const winner = await issue(campaign.campaignId, wallet(14));
    expect(await claim(campaign.campaignId, wallet(14), winner.challengeId)).toMatchObject({
      result_kind: "reserved",
    });

    const loser = await issue(campaign.campaignId, wallet(15));
    const rejected = await claim(campaign.campaignId, wallet(15), loser.challengeId);
    expect(rejected).toMatchObject({ result_kind: "no_reward_capacity" });
    expect((await readChallenge(loser.challengeId)).consumed_at).toBeNull();
    expect((await readReceipts(campaign.settlementId))).toHaveLength(1);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
  });

  it("writes first_reservation_at exactly once across reservations", async () => {
    const campaign = await createCampaign({ maxParticipants: 2 });
    const first = await issue(campaign.campaignId, wallet(16));
    await claim(campaign.campaignId, wallet(16), first.challengeId);
    const afterFirst = await readSettlement(campaign.settlementId);
    expect(afterFirst.first_reservation_at).not.toBeNull();

    const second = await issue(campaign.campaignId, wallet(17));
    await claim(campaign.campaignId, wallet(17), second.challengeId);
    const afterSecond = await readSettlement(campaign.settlementId);
    expect(afterSecond.first_reservation_at).toBe(afterFirst.first_reservation_at);
    expect(afterSecond.rewarded_participant_count).toBe(2);
    expect(afterSecond.status).toBe("exhausted");
  });
});
