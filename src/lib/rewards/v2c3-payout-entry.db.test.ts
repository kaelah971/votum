import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { createPollCampaignFixture, deletePollCampaignFixtureSql } from "@/lib/rewards/settlement-fixture";
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
const createdPollCampaignIds: string[] = [];
const createdPollIds: string[] = [];

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

async function openCampaign(maxParticipants = 10) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Payout entry fixture ${hex(4)}`,
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
    funded_amount_luna: 500000 * maxParticipants,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function reserve(campaignId: string, participant: string) {
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
  const row = data as Record<string, unknown>;
  if (row.result_kind !== "reserved") throw new Error(`reservation failed: ${String(row.result_kind)}`);
  return { receiptId: row.receipt_id as string, challengeId: issued.challengeId };
}

async function begin(receiptId: string, settlementId: string) {
  const { data, error } = await admin.rpc("begin_reward_payout_atomic", {
    _receipt_id: receiptId,
    _campaign_id: settlementId,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, first_reservation_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function readAttempts(receiptId: string) {
  const { data, error } = await admin.from("reward_payout_attempts")
    .select("id, receipt_id, attempt_number, status, transaction_hash")
    .eq("receipt_id", receiptId)
    .order("attempt_number");
  if (error) throw error;
  return data ?? [];
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  if (campaigns.length > 0) {
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
  }
  if (createdPollCampaignIds.length > 0) {
    runPsql(deletePollCampaignFixtureSql(createdPollCampaignIds, createdPollIds));
    createdPollCampaignIds.length = 0;
    createdPollIds.length = 0;
  }
});

describe("V2C.3D payout-entry cutover", () => {
  it("admits a real Campaign receipt into begin_reward_payout_atomic", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(61);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    const before = await readSettlement(campaign.settlementId);

    const result = await begin(receiptId, campaign.settlementId);
    expect(result.result_kind).toBe("created");
    expect(result.settlement_id).toBe(campaign.settlementId);
    expect(result.receipt_id).toBe(receiptId);
    expect(result.participant_wallet).toBe(claimant);
    expect(String(result.amount_luna)).toBe("50000");

    const attempts = await readAttempts(receiptId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_number: 1, status: "pending" });

    const { data: receipt } = await admin.from("reward_receipts")
      .select("campaign_id, poll_id, settlement_id, status")
      .eq("id", receiptId)
      .single();
    expect(receipt).toMatchObject({
      campaign_id: null,
      poll_id: null,
      settlement_id: campaign.settlementId,
      status: "payout_pending",
    });

    // Entry creates no reservation/capacity movement.
    const after = await readSettlement(campaign.settlementId);
    expect(after.rewarded_participant_count).toBe(before.rewarded_participant_count);
    expect(after.first_reservation_at).toBe(before.first_reservation_at);
  });

  it("replays begin and rejects mismatched settlement/receipt pairs", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(62);
    const { receiptId } = await reserve(campaign.campaignId, claimant);

    const first = await begin(receiptId, campaign.settlementId);
    expect(first.result_kind).toBe("created");
    const replay = await begin(receiptId, campaign.settlementId);
    expect(replay).toMatchObject({ result_kind: "replay", receipt_id: receiptId });
    expect(await readAttempts(receiptId)).toHaveLength(1);

    const other = await openCampaign();
    const mismatch = await begin(receiptId, other.settlementId);
    expect(mismatch.result_kind).toBe("receipt_not_found");
  });

  it("runs the retry path on a Campaign receipt per engine semantics", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(63);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    await begin(receiptId, campaign.settlementId);

    runPsql(`UPDATE public.reward_payout_attempts SET status = 'retryable', error_code = 'probe'
      WHERE receipt_id = '${receiptId}';
      UPDATE public.reward_receipts SET status = 'retryable' WHERE id = '${receiptId}';`);

    const { data, error } = await admin.rpc("retry_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    if (error) throw error;
    const retried = data as Record<string, unknown>;
    expect(retried.result_kind).toBe("retryable");
    expect(retried.receipt_id).toBe(receiptId);
    expect(retried.settlement_id).toBe(campaign.settlementId);

    const attempts = await readAttempts(receiptId);
    expect(attempts.map((row) => row.attempt_number)).toEqual([1, 2]);
    expect(attempts[1].status).toBe("pending");
    const { data: receipt } = await admin.from("reward_receipts")
      .select("status").eq("id", receiptId).single();
    expect(receipt?.status).toBe("payout_pending");
  });

  it("keeps Poll begin/retry behavior and receipt identity intact", async () => {
    const poll = await createPollCampaignFixture(admin as never, {});
    createdPollCampaignIds.push(poll.campaignId);
    createdPollIds.push(poll.pollId);
    const { error: vaultError } = await admin.from("reward_campaign_vaults").insert({
      campaign_id: poll.campaignId,
      settlement_id: poll.campaignId,
      vault_address_hex: poll.creatorWallet,
      envelope_version: "votum:reward-vault:v1",
      encryption_algorithm: "aes-256-gcm",
      encrypted_private_key_ciphertext: "fixture-ciphertext",
      encryption_iv: "fixture-iv",
      authentication_tag: "fixture-tag",
    });
    expect(vaultError).toBeNull();
    await admin.from("reward_settlements").update({ status: "rewarding" }).eq("id", poll.campaignId);

    const voter = wallet(64);
    const { data: receipt, error: receiptError } = await admin.from("reward_receipts").insert({
      campaign_id: poll.campaignId,
      settlement_id: poll.campaignId,
      poll_id: poll.pollId,
      participant_wallet: voter,
      amount_luna: 1000,
      status: "reserved",
    }).select("id").single();
    if (receiptError || !receipt) throw receiptError ?? new Error("poll receipt fixture missing");

    const begun = await begin(receipt.id, poll.campaignId);
    expect(begun.result_kind).toBe("created");
    expect(begun.campaign_id).toBe(poll.campaignId);
    const replay = await begin(receipt.id, poll.campaignId);
    expect(replay).toMatchObject({ result_kind: "replay", receipt_id: receipt.id });

    // Poll receipt identity protection: Campaign settlement cannot begin it.
    const campaign = await openCampaign();
    const crossBranch = await begin(receipt.id, campaign.settlementId);
    expect(crossBranch.result_kind).toBe("receipt_not_found");

    // Unknown settlement still fails closed with the shipped code.
    const unknown = await begin(receipt.id, randomUUID());
    expect(unknown.result_kind).toBe("campaign_not_found");
  });
});
