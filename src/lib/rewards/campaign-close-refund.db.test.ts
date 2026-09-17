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
const createdTokenHashes: string[] = [];

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
    title: `Close-refund fixture ${hex(4)}`,
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
  const { data: terms, error: termsError } = await admin.from("reward_settlements")
    .select("total_budget_luna")
    .eq("id", result.campaign.settlementId)
    .single();
  if (termsError || !terms) throw termsError ?? new Error("settlement terms missing");
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: terms.total_budget_luna,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function readEconomics(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("reward_principal_luna, fee_reserve_luna, refundable_excess_luna, total_budget_luna")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement economics missing");
  return {
    principal: BigInt(data.reward_principal_luna),
    feeReserve: BigInt(data.fee_reserve_luna),
    excess: BigInt(data.refundable_excess_luna),
    total: BigInt(data.total_budget_luna),
  };
}

async function ownerSession(): Promise<string> {
  const tokenHash = hex(32);
  const { error } = await admin.from("wallet_sessions").insert({
    token_hash: tokenHash,
    wallet_address: OWNER,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
  });
  if (error) throw error;
  createdTokenHashes.push(tokenHash);
  return tokenHash;
}

async function closeCampaign(campaignId: string) {
  const { data, error } = await admin.rpc("close_participation_campaign_atomic", {
    _campaign_id: campaignId,
    _owner_wallet: OWNER,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function beginRefund(settlementId: string, tokenHash: string) {
  const { data, error } = await admin.rpc("begin_campaign_refund_atomic", {
    _settlement_id: settlementId,
    _session_token_hash: tokenHash,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
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

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, paid_amount_luna, fee_spent_luna, refundable_amount_luna, refundable_excess_luna, first_reservation_at, closed_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function readRefunds(settlementId: string) {
  const { data, error } = await admin.from("reward_refunds")
    .select("id, campaign_id, settlement_id, creator_wallet, amount_luna, status, transaction_hash")
    .eq("settlement_id", settlementId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

async function readAttempts(receiptId: string) {
  const { data, error } = await admin.from("reward_payout_attempts")
    .select("id")
    .eq("receipt_id", receiptId);
  if (error) throw error;
  return data ?? [];
}

async function receiptCount(settlementId: string): Promise<number> {
  const { data } = await admin.from("reward_receipts").select("id").eq("settlement_id", settlementId);
  return data?.length ?? -1;
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
  if (createdTokenHashes.length > 0) {
    const hashes = createdTokenHashes.map((h) => `'${h}'`).join(", ");
    runPsql(`DELETE FROM public.wallet_sessions WHERE token_hash IN (${hashes});`);
    createdTokenHashes.length = 0;
  }
  if (createdPollCampaignIds.length > 0) {
    runPsql(deletePollCampaignFixtureSql(createdPollCampaignIds, createdPollIds));
    createdPollCampaignIds.length = 0;
    createdPollIds.length = 0;
  }
});

describe("begin_campaign_refund_atomic", () => {
  it("begins refund on a closed Campaign with no obligations", async () => {
    const campaign = await openCampaign(4);
    const token = await ownerSession();
    expect(await closeCampaign(campaign.campaignId)).toMatchObject({ result_kind: "closed" });

    const result = await beginRefund(campaign.settlementId, token);
    expect(result.result_kind).toBe("created");
    expect(result.settlement_id).toBe(campaign.settlementId);
    expect(result.campaign_id).toBe(campaign.campaignId);
    expect(result.creator_wallet).toBe(OWNER);
    const economics = await readEconomics(campaign.settlementId);
    expect(String(result.amount_luna)).toBe(String(economics.total));
    expect(result.status).toBe("pending");

    const refunds = await readRefunds(campaign.settlementId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      creator_wallet: OWNER,
      status: "pending",
      transaction_hash: null,
    });
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunding");
    expect(String(settled.refundable_amount_luna)).toBe(String(economics.total));
  });

  it("begins refund on elapsed window without creator close", async () => {
    const created = await createParticipationCampaign(OWNER, {
      type: "public_giveaway",
      title: `Elapsed refund fixture ${hex(4)}`,
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: new Date(Date.now() - 60_000).toISOString(),
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(created.campaign.campaignId);
    createdRootIds.push(created.campaign.settlementId);
    await ensureRewardSettlementVault(created.campaign.settlementId);
    await publishParticipationCampaign(OWNER, created.campaign.campaignId);
    const { data: terms, error: termsError } = await admin.from("reward_settlements")
      .select("total_budget_luna").eq("id", created.campaign.settlementId).single();
    if (termsError || !terms) throw termsError ?? new Error("settlement terms missing");
    await admin.from("reward_settlements").update({
      status: "funded",
      funded_amount_luna: terms.total_budget_luna,
      funded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", created.campaign.settlementId);

    const token = await ownerSession();
    const result = await beginRefund(created.campaign.settlementId, token);
    expect(result.result_kind).toBe("created");
    expect((await readSettlement(created.campaign.settlementId)).status).toBe("refunding");
  });

  it("rejects bad auth, unknown settlement, and Poll-branch settlements", async () => {
    const campaign = await openCampaign();
    await closeCampaign(campaign.campaignId);

    expect(await beginRefund(campaign.settlementId, hex(32))).toMatchObject({ result_kind: "forbidden" });
    expect(await beginRefund(campaign.settlementId, "")).toMatchObject({ result_kind: "forbidden" });

    const token = await ownerSession();
    const poll = await createPollCampaignFixture(admin as never, {});
    createdPollCampaignIds.push(poll.campaignId);
    createdPollIds.push(poll.pollId);
    expect(await beginRefund(poll.campaignId, token)).toMatchObject({ result_kind: "campaign_not_found" });
    expect(await beginRefund(randomUUID(), token)).toMatchObject({ result_kind: "campaign_not_found" });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
  });

  it("replays repeated begin without duplicating the intent", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);

    const first = await beginRefund(campaign.settlementId, token);
    expect(first.result_kind).toBe("created");
    const second = await beginRefund(campaign.settlementId, token);
    expect(second).toMatchObject({ result_kind: "replay", refund_id: first.refund_id });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(1);
  });

  it("blocks refund while reserved, payout_pending, and retryable obligations exist", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await reserve(campaign.campaignId, wallet(101));

    // Reserved alone blocks.
    await closeCampaign(campaign.campaignId);
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "unresolved_reward_obligations",
    });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
    expect((await readSettlement(campaign.settlementId)).status).toBe("closed");
  });

  it("blocks refund while a payout_pending obligation exists", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(107));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    await closeCampaign(campaign.campaignId);
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "unresolved_reward_obligations",
    });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
  });

  it("blocks refund while a retryable obligation exists", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(110));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    // Retryable setup happens BEFORE close: both freeze triggers reject
    // attempt/receipt writes once the settlement is closed (see the
    // payout-after-close proof below).
    runPsql(`UPDATE public.reward_payout_attempts SET status = 'retryable', error_code = 'probe'
      WHERE receipt_id = '${receiptId}';
      UPDATE public.reward_receipts SET status = 'retryable' WHERE id = '${receiptId}';`);
    await closeCampaign(campaign.campaignId);
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "unresolved_reward_obligations",
    });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
  });

  it("blocks refund while hash-bearing unknown attempts need reconciliation", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(102));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    const attemptId = (begun as Record<string, unknown>).attempt_id as string;
    runPsql(`UPDATE public.reward_payout_attempts
      SET transaction_hash = '${hex(32)}', broadcast_started_at = now(), error_code = 'probe-unknown'
      WHERE id = '${attemptId}';`);
    await closeCampaign(campaign.campaignId);

    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "payout_reconciliation_required",
    });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
  });

  it("advances a pre-existing receipt through payout after creator close", async () => {
    const campaign = await openCampaign();
    const { receiptId } = await reserve(campaign.campaignId, wallet(108));
    await closeCampaign(campaign.campaignId);

    const { data: begun, error } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect(error).toBeNull();
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    const attemptId = (begun as Record<string, unknown>).attempt_id as string;

    const { data: vault } = await admin.from("reward_campaign_vaults")
      .select("vault_address_hex").eq("settlement_id", campaign.settlementId).single();
    const { data: prepared, error: prepareError } = await admin.rpc("prepare_reward_payout_atomic", {
      _attempt_id: attemptId,
      _sender_address_hex: vault?.vault_address_hex as string,
      _recipient_address_hex: wallet(108),
      _amount_luna: 50000,
      _fee_luna: 0,
      _network_id: 24,
      _validity_start_height: 100,
      _transaction_hash: hex(32),
      _prepared_transaction_hex: "ab".repeat(32),
    });
    expect(prepareError).toBeNull();
    expect((prepared as Record<string, unknown>).result_kind).toBe("prepared");

    const { data: receipt } = await admin.from("reward_receipts")
      .select("status, campaign_id, poll_id, participant_wallet, amount_luna")
      .eq("id", receiptId).single();
    expect(receipt).toMatchObject({
      status: "payout_pending",
      campaign_id: null,
      poll_id: null,
      participant_wallet: wallet(108),
    });
    expect(String(receipt?.amount_luna)).toBe("50000");
    expect(await receiptCount(campaign.settlementId)).toBe(1);
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.rewarded_participant_count).toBe(1);

    // New claims stay closed even though payout proceeds.
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet(109),
    });
    const { data: rejected, error: claimError } = await admin.rpc("claim_campaign_reward_atomic", {
      _campaign_id: campaign.campaignId,
      _participant_wallet: wallet(109),
      _challenge_id: issued.challengeId,
    });
    expect(claimError).toBeNull();
    expect((rejected as Record<string, unknown>).result_kind).toBe("campaign_closed");
    expect(await receiptCount(campaign.settlementId)).toBe(1);
  });

  it("excludes paid principal and refunds only the unused remainder", async () => {
    const campaign = await openCampaign(2);
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(103));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    const attemptId = (begun as Record<string, unknown>).attempt_id as string;
    runPsql(`UPDATE public.reward_payout_attempts SET status = 'confirmed', confirmed_at = now(), fee_luna = 0
      WHERE id = '${attemptId}';
      UPDATE public.reward_receipts SET status = 'paid', paid_at = now() WHERE id = '${receiptId}';
      UPDATE public.reward_settlements SET paid_amount_luna = 50000 WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);

    const result = await beginRefund(campaign.settlementId, token);
    expect(result.result_kind).toBe("created");
    // Unused principal minus paid, plus untouched fee reserve and excess.
    const economics = await readEconomics(campaign.settlementId);
    expect(String(result.amount_luna)).toBe(String(economics.principal - BigInt(50000) + economics.feeReserve + economics.excess));
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunding");
  });

  it("reaches the terminal refunded state with zero remainder and no fake transfer", async () => {
    const campaign = await openCampaign(1);
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(104));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    const attemptId = (begun as Record<string, unknown>).attempt_id as string;
    // Fully settle principal plus the entire fee reserve so the ledger
    // remainder is exactly zero. Fee spend flows through the canonical
    // confirmed-payout fee trigger, mirroring real payout finality.
    const economics = await readEconomics(campaign.settlementId);
    runPsql(`UPDATE public.reward_payout_attempts SET status = 'confirmed', confirmed_at = now(), fee_luna = ${economics.feeReserve}
      WHERE id = '${attemptId}';
      UPDATE public.reward_receipts SET status = 'paid', paid_at = now() WHERE id = '${receiptId}';
      UPDATE public.reward_settlements SET paid_amount_luna = ${economics.principal}
      WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);

    const result = await beginRefund(campaign.settlementId, token);
    expect(result).toMatchObject({ result_kind: "nothing_to_refund", amount_luna: "0" });
    expect(result.transaction_hash).toBeNull();
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunded");
  });

  it("leaves receipts, counters, and challenges untouched by refund begin", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const first = await reserve(campaign.campaignId, wallet(105));
    const second = await reserve(campaign.campaignId, wallet(106));

    // Settle both obligations so begin is allowed. Paid-marking via the
    // payout-lifecycle transition is permitted on closed settlements; the
    // freeze still bars new entitlements, identity/amount rewrites, and any
    // write once refunding/refunded.
    const { data: receipts } = await admin.from("reward_receipts")
      .select("id, amount_luna").eq("settlement_id", campaign.settlementId);
    runPsql(`UPDATE public.reward_receipts SET status = 'paid', paid_at = now()
      WHERE settlement_id = '${campaign.settlementId}';
      UPDATE public.reward_settlements SET paid_amount_luna = 100000
      WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);

    const before = await readSettlement(campaign.settlementId);
    const result = await beginRefund(campaign.settlementId, token);
    expect(result.result_kind).toBe("created");

    const { data: afterReceipts } = await admin.from("reward_receipts")
      .select("id").eq("settlement_id", campaign.settlementId);
    expect(afterReceipts).toHaveLength(receipts?.length ?? -1);
    const after = await readSettlement(campaign.settlementId);
    expect(after.rewarded_participant_count).toBe(before.rewarded_participant_count);
    expect(after.first_reservation_at).toBe(before.first_reservation_at);
    expect(first.receiptId).toBeTruthy();
    expect(second.receiptId).toBeTruthy();
  });

  it("still rejects new receipts, rewrites, and moves after close", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(111));
    await closeCampaign(campaign.campaignId);

    // New entitlement after close.
    const fresh = await admin.from("reward_receipts").insert({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      poll_id: null,
      participant_wallet: wallet(112),
      amount_luna: 50000,
      status: "reserved",
    });
    expect(fresh.error).not.toBeNull();
    expect(fresh.data).toBeNull();

    // Amount rewrite of the existing receipt.
    const rewritten = await admin.from("reward_receipts")
      .update({ amount_luna: 1 })
      .eq("id", receiptId);
    expect(rewritten.error ?? null).not.toBeNull();

    // Wallet rewrite of the existing receipt.
    const moved = await admin.from("reward_receipts")
      .update({ participant_wallet: wallet(113) })
      .eq("id", receiptId);
    expect(moved.error ?? null).not.toBeNull();

    // Settlement move of the existing receipt.
    const other = await openCampaign();
    const relocated = await admin.from("reward_receipts")
      .update({ settlement_id: other.settlementId })
      .eq("id", receiptId);
    expect(relocated.error ?? null).not.toBeNull();

    expect(await receiptCount(campaign.settlementId)).toBe(1);
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
    void token;
  });

  it("keeps the freeze in force once refunding or refunded", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(117));
    const { data: settled } = await admin.from("reward_receipts")
      .select("status").eq("id", receiptId).single();
    expect(settled?.status).toBe("reserved");

    // Settle the obligation pre-close so refund may begin.
    runPsql(`UPDATE public.reward_receipts SET status = 'paid', paid_at = now() WHERE id = '${receiptId}';
      UPDATE public.reward_settlements SET paid_amount_luna = 50000 WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({ result_kind: "created" });
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunding");

    // Lifecycle-shaped writes no longer pass once refunding starts.
    const direct = await admin.from("reward_receipts")
      .update({ status: "payout_pending" })
      .eq("id", receiptId);
    expect(direct.error ?? null).not.toBeNull();

    // New claims stay closed as well.
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet(114),
    });
    const { data: rejected, error: claimError } = await admin.rpc("claim_campaign_reward_atomic", {
      _campaign_id: campaign.campaignId,
      _participant_wallet: wallet(114),
      _challenge_id: issued.challengeId,
    });
    expect(claimError).toBeNull();
    expect((rejected as Record<string, unknown>).result_kind).toBe("campaign_closed");
  });

  it("serializes payout-start before refund-begin without double counting", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(115));

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    await closeCampaign(campaign.campaignId);

    // The pending payout is an unresolved obligation: refund waits for it.
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "unresolved_reward_obligations",
    });
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);
    const { data: attempts } = await admin.from("reward_payout_attempts")
      .select("id").eq("receipt_id", receiptId);
    expect(attempts).toHaveLength(1);
  });

  it("serializes refund-begin before payout-start without overlap", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    const { receiptId } = await reserve(campaign.campaignId, wallet(116));

    // Settle the single obligation first so refund may begin.
    runPsql(`UPDATE public.reward_receipts SET status = 'paid', paid_at = now() WHERE id = '${receiptId}';
      UPDATE public.reward_settlements SET paid_amount_luna = 50000 WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);
    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({ result_kind: "created" });
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunding");

    // Payout can no longer start once refunding owns the remainder.
    const { data: late } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((late as Record<string, unknown>).result_kind).toBe("receipt_paid");
    expect(await readAttempts(receiptId)).toHaveLength(0);
  });
});
