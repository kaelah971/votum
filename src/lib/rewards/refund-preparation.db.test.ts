import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const PRINCIPAL = 10_000;
const FEE_RESERVE = 1_000;
const FUNDED = 11_200;
const EXCESS = 200;
const REWARD = 1_000;
const MAX_PARTICIPANTS = 10;

const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureWallets: string[] = [];
const fixtureSessionHashes = new Map<string, string>();

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

type Fixture = {
  pollId: string;
  campaignId: string;
  creatorWallet: string;
  vaultAddress: string;
  optionA: string;
  optionB: string;
  addVote: (wallet: string, optionId?: string) => Promise<string>;
};

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function resultKind(result: RpcResult): string | null {
  const value = result.data;
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as Record<string, unknown>).result_kind;
  return typeof kind === "string" ? kind : null;
}

function resultRecord(result: RpcResult): Record<string, unknown> {
  if (typeof result.data !== "object" || result.data === null) return {};
  return result.data as Record<string, unknown>;
}

async function createFixture(options: {
  campaignStatus?: string;
  pollStatus?: "live" | "closed";
  endsAt?: string;
  firstReservationAt?: string | null;
  fundedAmountLuna?: number;
  refundableExcessLuna?: number;
  paidAmountLuna?: number;
  feeSpentLuna?: number;
  rewardPrincipalLuna?: number;
  feeReserveLuna?: number;
  maxRewardedParticipants?: number;
  rewardPerParticipantLuna?: number;
  vaultWallet?: string;
} = {}): Promise<Fixture> {
  const creatorWallet = wallet();
  const vaultAddress = options.vaultWallet ?? wallet();
  fixtureWallets.push(creatorWallet, vaultAddress);

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Refund preparation ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: options.pollStatus ?? "closed",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: options.endsAt ?? new Date(Date.now() - 1_000).toISOString(),
    is_public: true,
    published_at: new Date(Date.now() - 86_400_000).toISOString(),
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");
  fixturePollIds.push(poll.id);

  const rewardPrincipalLuna = options.rewardPrincipalLuna ?? PRINCIPAL;
  const feeReserveLuna = options.feeReserveLuna ?? FEE_RESERVE;
  const fundedAmountLuna = options.fundedAmountLuna ?? FUNDED;
  const refundableExcessLuna = options.refundableExcessLuna ?? EXCESS;
  const maxRewardedParticipants = options.maxRewardedParticipants ?? MAX_PARTICIPANTS;
  const rewardPerParticipantLuna = options.rewardPerParticipantLuna ?? REWARD;

  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .insert({
      poll_id: poll.id,
      creator_wallet: creatorWallet,
      funding_mode: "creator",
      funding_wallet: creatorWallet,
      reward_per_participant_luna: rewardPerParticipantLuna,
      max_rewarded_participants: maxRewardedParticipants,
      reward_principal_luna: rewardPrincipalLuna,
      fee_reserve_luna: feeReserveLuna,
      total_budget_luna: rewardPrincipalLuna + feeReserveLuna,
      status: options.campaignStatus ?? "funded",
      funded_amount_luna: fundedAmountLuna,
      refundable_excess_luna: refundableExcessLuna,
      paid_amount_luna: options.paidAmountLuna ?? 0,
      fee_spent_luna: options.feeSpentLuna ?? 0,
      first_reservation_at: options.firstReservationAt ?? null,
      vault_wallet: vaultAddress,
      funded_at: new Date(Date.now() - 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);

  const { data: optionsRows, error: optionsError } = await admin.from("poll_options").insert([
    { poll_id: poll.id, label: "Option A", sort_order: 0 },
    { poll_id: poll.id, label: "Option B", sort_order: 1 },
  ]).select("id, label");
  if (optionsError || !optionsRows || optionsRows.length !== 2) {
    throw optionsError ?? new Error("poll options missing");
  }
  const sortedOptions = [...optionsRows].sort((left, right) => left.label.localeCompare(right.label));
  const pollId = poll.id;

  const { error: vaultError } = await admin.from("reward_campaign_vaults").insert({
    campaign_id: campaign.id,
    vault_address_hex: vaultAddress,
    envelope_version: "votum:reward-vault:v1",
    encryption_algorithm: "aes-256-gcm",
    encrypted_private_key_ciphertext: "fixture-ciphertext",
    encryption_iv: "fixture-iv",
    authentication_tag: "fixture-tag",
  });
  if (vaultError) throw vaultError;

  const creatorSessionHash = randomBytes(32).toString("hex");
  const { error: sessionError } = await admin.from("wallet_sessions").insert({
    token_hash: creatorSessionHash,
    wallet_address: creatorWallet,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (sessionError) throw sessionError;
  fixtureSessionHashes.set(campaign.id, creatorSessionHash);

  async function addVote(voterWallet: string, optionId = sortedOptions[0].id): Promise<string> {
    fixtureWallets.push(voterWallet);
    const { error: sessionError } = await admin.from("wallet_sessions").insert({
      token_hash: randomBytes(32).toString("hex"),
      wallet_address: voterWallet,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (sessionError) throw sessionError;

    const { data: vote, error: voteError } = await admin.from("poll_votes").insert({
      poll_id: pollId,
      option_id: optionId,
      voter_wallet: voterWallet,
    }).select("id").single();
    if (voteError || !vote) throw voteError ?? new Error("vote fixture missing");
    return vote.id;
  }

  return {
    pollId: poll.id,
    campaignId: campaign.id,
    creatorWallet,
    vaultAddress,
    optionA: sortedOptions[0].id,
    optionB: sortedOptions[1].id,
    addVote,
  };
}

async function insertReceipt(
  fixture: Fixture,
  status: "eligible" | "reserved" | "payout_pending" | "paid" | "failed" | "retryable",
  options: { amountLuna?: number; participantWallet?: string } = {},
): Promise<{ id: string; participantWallet: string }> {
  const participantWallet = options.participantWallet ?? wallet();
  fixtureWallets.push(participantWallet);
  const { data, error } = await admin.from("reward_receipts").insert({
    campaign_id: fixture.campaignId,
    poll_id: fixture.pollId,
    participant_wallet: participantWallet,
    amount_luna: options.amountLuna ?? REWARD,
    status,
    paid_at: status === "paid" ? new Date().toISOString() : null,
  }).select("id").single();
  if (error || !data) throw error ?? new Error("receipt fixture missing");
  return { id: data.id, participantWallet };
}

async function insertAttempt(
  receiptId: string,
  options: {
    status?: "pending" | "confirmed" | "failed" | "retryable";
    feeLuna?: number | null;
    transactionHash?: string | null;
    broadcastStartedAt?: string | null;
    broadcastAt?: string | null;
    errorCode?: string | null;
  } = {},
): Promise<string> {
  const { data, error } = await admin.from("reward_payout_attempts").insert({
    receipt_id: receiptId,
    attempt_number: 1,
    status: options.status ?? "pending",
    fee_luna: options.feeLuna ?? null,
    transaction_hash: options.transactionHash ?? null,
    broadcast_started_at: options.broadcastStartedAt ?? null,
    broadcast_at: options.broadcastAt ?? null,
    error_code: options.errorCode ?? null,
  }).select("id").single();
  if (error || !data) throw error ?? new Error("payout attempt fixture missing");
  return data.id;
}

async function beginRefund(campaignId: string, extra: Record<string, unknown> = {}): Promise<RpcResult> {
  const { data, error } = await admin.rpc("begin_reward_refund_atomic", {
    _campaign_id: campaignId,
    _session_token_hash: fixtureSessionHashes.get(campaignId) ?? null,
    ...extra,
  });
  return { data, error };
}

async function readCampaign(campaignId: string) {
  const { data, error } = await admin.from("reward_campaigns")
    .select("status, refundable_amount_luna, closed_at, refunded_at, creator_wallet, vault_wallet, funded_amount_luna, paid_amount_luna, fee_spent_luna, refundable_excess_luna")
    .eq("id", campaignId).single();
  if (error || !data) throw error ?? new Error("campaign state missing");
  return data;
}

async function readRefund(campaignId: string) {
  const { data, error } = await admin.from("reward_refunds")
    .select("id, campaign_id, creator_wallet, amount_luna, status, transaction_hash, created_at, updated_at")
    .eq("campaign_id", campaignId).maybeSingle();
  if (error) throw error;
  return data;
}

async function countRows(table: "reward_refunds" | "reward_payout_attempts" | "reward_receipts", campaignId: string): Promise<number> {
  if (table === "reward_refunds" || table === "reward_receipts") {
    const { count, error } = await admin.from(table)
      .select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    if (error) throw error;
    return count ?? 0;
  }

  const { data: receipts, error: receiptError } = await admin.from("reward_receipts")
    .select("id").eq("campaign_id", campaignId);
  if (receiptError) throw receiptError;
  if (!receipts || receipts.length === 0) return 0;
  const { count, error } = await admin.from(table)
    .select("id", { count: "exact", head: true })
    .in("receipt_id", receipts.map((receipt) => receipt.id));
  if (error) throw error;
  return count ?? 0;
}

function cleanupFixtures(): void {
  if (fixtureCampaignIds.length === 0) return;
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  const wallets = fixtureWallets.map(sqlQuote).join(", ");
  runPsql(`
    SET session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE campaign_id IN (${campaigns}));
    DELETE FROM public.reward_refunds WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_funding_transactions WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_receipts WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.poll_votes WHERE poll_id IN (${polls});
    DELETE FROM public.poll_options WHERE poll_id IN (${polls});
    DELETE FROM public.polls WHERE id IN (${polls});
    DELETE FROM public.wallet_sessions WHERE wallet_address IN (${wallets || "NULL"});
    SET session_replication_role = origin;
  `);
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
  fixtureWallets.length = 0;
  fixtureSessionHashes.clear();
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanupFixtures());
afterAll(() => cleanupFixtures());

describe("begin_reward_refund_atomic", () => {
  it("creates one refund intent for a closable funded campaign", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId);

    expect(result.error).toBeNull();
    expect(resultKind(result)).toBe("created");
    expect(resultRecord(result)).toMatchObject({
      campaign_id: fixture.campaignId,
      creator_wallet: fixture.creatorWallet,
      vault_address_hex: fixture.vaultAddress,
      amount_luna: "11200",
      campaign_status: "refunding",
      status: "pending",
      transaction_hash: null,
    });
    expect(await readRefund(fixture.campaignId)).toMatchObject({
      campaign_id: fixture.campaignId,
      creator_wallet: fixture.creatorWallet,
      amount_luna: FUNDED,
      status: "pending",
      transaction_hash: null,
    });
    expect((await readCampaign(fixture.campaignId)).status).toBe("refunding");
  });

  it("freezes the exact Phase A amount and destination from server data", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId, {
      _amount_luna: 1,
      _creator_wallet: wallet(),
      _vault_address_hex: wallet(),
      _vault_balance_luna: 1,
      closable: true,
    });

    expect(result.error).not.toBeNull();
    expect(await readRefund(fixture.campaignId)).toBeNull();

    const created = await beginRefund(fixture.campaignId);
    expect(resultKind(created)).toBe("created");
    expect(resultRecord(created)).toMatchObject({
      creator_wallet: fixture.creatorWallet,
      vault_address_hex: fixture.vaultAddress,
      amount_luna: "11200",
    });
  });

  it("derives creator destination from the campaign owner and poll owner", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId);

    expect(resultRecord(result).creator_wallet).toBe(fixture.creatorWallet);
    expect(resultRecord(result).creator_wallet).not.toBe(fixture.vaultAddress);
    expect((await readRefund(fixture.campaignId))?.creator_wallet).toBe(fixture.creatorWallet);
  });

  it("derives the vault identity from reward_campaign_vaults", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId);

    expect(resultRecord(result).vault_address_hex).toBe(fixture.vaultAddress);
  });

  it("blocks an active campaign before its participation window closes", async () => {
    const fixture = await createFixture({ pollStatus: "live", endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("campaign_not_closable");
    expect(await readRefund(fixture.campaignId)).toBeNull();
    expect((await readCampaign(fixture.campaignId)).status).toBe("funded");
  });

  it("blocks a reserved receipt", async () => {
    const fixture = await createFixture();
    await insertReceipt(fixture, "reserved");
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("unresolved_reward_obligations");
    expect(resultRecord(result).unresolved_receipt_count).toBe(1);
  });

  it("blocks a payout_pending receipt", async () => {
    const fixture = await createFixture();
    await insertReceipt(fixture, "payout_pending");
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("unresolved_reward_obligations");
  });

  it("allows an eligible receipt with no payout obligation to settle into the remainder", async () => {
    const fixture = await createFixture();
    await insertReceipt(fixture, "eligible");
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("created");
  });

  it("allows a terminal failed receipt with no payout evidence to settle into the remainder", async () => {
    const fixture = await createFixture();
    await insertReceipt(fixture, "failed");
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("created");
  });

  it("blocks retryable manual-review payout work", async () => {
    const fixture = await createFixture();
    const receipt = await insertReceipt(fixture, "retryable");
    await insertAttempt(receipt.id, { status: "retryable", errorCode: "manual_review_required" });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("payout_reconciliation_required");
  });

  it("blocks a hash-bearing unresolved payout", async () => {
    const fixture = await createFixture();
    const receipt = await insertReceipt(fixture, "payout_pending");
    await insertAttempt(receipt.id, {
      status: "pending",
      transactionHash: "a".repeat(64),
      broadcastStartedAt: new Date().toISOString(),
      errorCode: "broadcast_unknown",
    });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("payout_reconciliation_required");
  });

  it("allows all-paid obligations and freezes the remaining amount", async () => {
    const fixture = await createFixture({ paidAmountLuna: 1_000 });
    await insertReceipt(fixture, "paid");
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("created");
    expect(resultRecord(result).amount_luna).toBe("10200");
    expect((await readCampaign(fixture.campaignId)).refundable_amount_luna).toBe(10200);
  });

  it("includes unused principal in the frozen amount", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId);
    const record = resultRecord(result);

    expect(record.unused_reward_principal_luna).toBe("10000");
    expect(record.ledger_refundable_amount_luna).toBe("11200");
  });

  it("includes excess funding exactly once", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId);
    const record = resultRecord(result);

    expect(record.refundable_excess_luna).toBe("200");
    expect(record.unused_reward_principal_luna).toBe("10000");
    expect(record.unused_fee_reserve_luna).toBe("1000");
    expect(record.ledger_refundable_amount_luna).toBe("11200");
    expect(record.amount_luna).toBe("11200");
  });

  it("returns only unused fee reserve after confirmed fee spend", async () => {
    const fixture = await createFixture({ paidAmountLuna: REWARD, fundedAmountLuna: 11_200 });
    const receipt = await insertReceipt(fixture, "paid", { amountLuna: REWARD });
    await insertAttempt(receipt.id, { status: "confirmed", feeLuna: 200 });
    const result = await beginRefund(fixture.campaignId);
    const record = resultRecord(result);

    expect(record.unused_fee_reserve_luna).toBe("800");
    expect(record.amount_luna).toBe("10000");
  });

  it("caps the refund at the safe confirmed campaign residual", async () => {
    const fixture = await createFixture({ paidAmountLuna: 6_200 });
    await insertReceipt(fixture, "paid", { amountLuna: 6_200 });
    const result = await beginRefund(fixture.campaignId);
    const record = resultRecord(result);

    expect(record.amount_luna).toBe("5000");
    expect(Number(record.amount_luna)).toBeLessThanOrEqual(FUNDED - 6_200);
  });

  it("rejects malformed accounting without a negative refund", async () => {
    const fixture = await createFixture({ paidAmountLuna: PRINCIPAL + 1_200 });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("invalid_reward_accounting");
    expect(resultRecord(result).amount_luna).toBe("0");
    expect(await readRefund(fixture.campaignId)).toBeNull();
    expect((await readCampaign(fixture.campaignId)).status).toBe("funded");
  });

  it("returns deterministic no-refund for a zero balance", async () => {
    const fixture = await createFixture({
      campaignStatus: "exhausted",
      rewardPrincipalLuna: 1_000,
      feeReserveLuna: 0,
      fundedAmountLuna: 1_000,
      refundableExcessLuna: 0,
      paidAmountLuna: 1_000,
      maxRewardedParticipants: 1,
    });
    await insertReceipt(fixture, "paid", { amountLuna: 1_000 });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("nothing_to_refund");
    expect(resultRecord(result).amount_luna).toBe("0");
    expect(await readRefund(fixture.campaignId)).toBeNull();
    expect((await readCampaign(fixture.campaignId)).status).toBe("refunded");
    expect((await readCampaign(fixture.campaignId)).refunded_at).not.toBeNull();
  });

  it("replays the same durable intent without changing its freeze", async () => {
    const fixture = await createFixture();
    const first = await beginRefund(fixture.campaignId);
    const firstRefund = await readRefund(fixture.campaignId);
    const firstCampaign = await readCampaign(fixture.campaignId);
    const replay = await beginRefund(fixture.campaignId);
    const secondRefund = await readRefund(fixture.campaignId);
    const secondCampaign = await readCampaign(fixture.campaignId);

    expect(resultKind(first)).toBe("created");
    expect(resultKind(replay)).toBe("replay");
    expect(resultRecord(replay).refund_id).toBe(resultRecord(first).refund_id);
    expect(secondRefund).toEqual(firstRefund);
    expect(secondCampaign.closed_at).toBe(firstCampaign.closed_at);
    expect(secondCampaign.refundable_amount_luna).toBe(firstCampaign.refundable_amount_luna);
    expect(await countRows("reward_refunds", fixture.campaignId)).toBe(1);
  });

  it("creates only one intent under concurrent begin-refund calls", async () => {
    const fixture = await createFixture();
    const results = await Promise.all([
      beginRefund(fixture.campaignId),
      beginRefund(fixture.campaignId),
    ]);

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(results.filter((result) => resultKind(result) === "created")).toHaveLength(1);
    expect(results.filter((result) => resultKind(result) === "replay")).toHaveLength(1);
    expect(await countRows("reward_refunds", fixture.campaignId)).toBe(1);
  });

  it("prepares a closed campaign once and does not prepare a refunded campaign", async () => {
    const closed = await createFixture({ campaignStatus: "closed" });
    const closedResult = await beginRefund(closed.campaignId);
    expect(resultKind(closedResult)).toBe("created");
    expect(resultKind(await beginRefund(closed.campaignId))).toBe("replay");

    const refunded = await createFixture({ campaignStatus: "refunded" });
    const { error: statusError } = await admin.from("reward_campaigns")
      .update({ status: "funded" }).eq("id", refunded.campaignId);
    expect(statusError).not.toBeNull();
    const refundedResult = await beginRefund(refunded.campaignId);
    expect(resultKind(refundedResult)).toBe("already_refunded_or_closed");
    expect(await countRows("reward_refunds", refunded.campaignId)).toBe(0);
  });

  it("allows funded cancellation before first_reservation_at", async () => {
    const fixture = await createFixture({ campaignStatus: "cancelled" });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("created");
    expect((await readCampaign(fixture.campaignId)).status).toBe("refunding");
  });

  it("blocks cancellation after first_reservation_at", async () => {
    const fixture = await createFixture({
      campaignStatus: "cancelled",
      firstReservationAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("campaign_not_closable");
    expect(await readRefund(fixture.campaignId)).toBeNull();
  });

  it("freezes campaign economics after preparation", async () => {
    const fixture = await createFixture();
    expect(resultKind(await beginRefund(fixture.campaignId))).toBe("created");
    const { error } = await admin.from("reward_campaigns")
      .update({ reward_per_participant_luna: 2_000, reward_principal_luna: 20_000 })
      .eq("id", fixture.campaignId);

    expect(error).not.toBeNull();
    expect((await readCampaign(fixture.campaignId)).refundable_amount_luna).toBe(FUNDED);
  });

  it("freezes refund amount and destination after preparation", async () => {
    const fixture = await createFixture();
    expect(resultKind(await beginRefund(fixture.campaignId))).toBe("created");
    const refund = await readRefund(fixture.campaignId);
    if (!refund) throw new Error("refund fixture missing");
    const { error } = await admin.from("reward_refunds")
      .update({ amount_luna: 1, creator_wallet: wallet() }).eq("id", refund.id);

    expect(error).not.toBeNull();
    expect(await readRefund(fixture.campaignId)).toEqual(refund);
  });

  it("rejects refund preparation without the creator's verified session", async () => {
    const fixture = await createFixture();
    const result = await beginRefund(fixture.campaignId, { _session_token_hash: null });

    expect(resultKind(result)).toBe("forbidden");
    expect(await readRefund(fixture.campaignId)).toBeNull();
  });

  it("blocks reservation after the economic freeze", async () => {
    const fixture = await createFixture();
    const participationId = await fixture.addVote(wallet(), fixture.optionA);
    expect(resultKind(await beginRefund(fixture.campaignId))).toBe("created");
    const { data, error } = await admin.rpc("claim_reward_receipt_atomic", {
      _participation_id: participationId,
      _campaign_id: fixture.campaignId,
    });

    expect(error).toBeNull();
    expect((data as Record<string, unknown>).result_kind).toBe("campaign_not_reservable");
    expect(await countRows("reward_receipts", fixture.campaignId)).toBe(0);
  });

  it("blocks new payout obligations after the economic freeze", async () => {
    const fixture = await createFixture();
    expect(resultKind(await beginRefund(fixture.campaignId))).toBe("created");
    const { error } = await admin.from("reward_receipts").insert({
      campaign_id: fixture.campaignId,
      poll_id: fixture.pollId,
      participant_wallet: wallet(),
      amount_luna: REWARD,
      status: "reserved",
    });

    expect(error).not.toBeNull();
    expect(await countRows("reward_payout_attempts", fixture.campaignId)).toBe(0);
  });

  it("does not refund when reservation races preparation", async () => {
    const fixture = await createFixture();
    const participationId = await fixture.addVote(wallet(), fixture.optionB);
    const [refundResult, reservationResult] = await Promise.all([
      beginRefund(fixture.campaignId),
      admin.rpc("claim_reward_receipt_atomic", {
        _participation_id: participationId,
        _campaign_id: fixture.campaignId,
      }),
    ]);

    const refundKind = resultKind(refundResult);
    const reservationKind = resultKind({ data: reservationResult.data, error: reservationResult.error });
    expect(
      refundKind === "created" && reservationKind === "campaign_not_reservable" ||
      refundKind === "unresolved_reward_obligations" && reservationKind === "reserved",
    ).toBe(true);
    expect(
      refundKind === "created" && reservationKind === "reserved",
    ).toBe(false);
  });

  it("does not refund when payout preparation races preparation", async () => {
    const fixture = await createFixture();
    const receipt = await insertReceipt(fixture, "reserved");
    const [refundResult, payoutResult] = await Promise.all([
      beginRefund(fixture.campaignId),
      admin.rpc("begin_reward_payout_atomic", {
        _receipt_id: receipt.id,
        _campaign_id: fixture.campaignId,
      }),
    ]);

    const refundKind = resultKind(refundResult);
    const payoutKind = resultKind({ data: payoutResult.data, error: payoutResult.error });
    expect(refundKind).toBe("unresolved_reward_obligations");
    expect(["created", "campaign_not_rewarding"].includes(payoutKind ?? "")).toBe(true);
    expect(await readRefund(fixture.campaignId)).toBeNull();
  });

  it("rejects a paid-ledger accounting mismatch without creating a refund", async () => {
    const fixture = await createFixture({ paidAmountLuna: REWARD });
    const result = await beginRefund(fixture.campaignId);

    expect(resultKind(result)).toBe("invalid_reward_accounting");
    expect(await readRefund(fixture.campaignId)).toBeNull();
  });

  it("creates no payout attempt, transaction hash, or selected-option data", async () => {
    const fixture = await createFixture();
    const voteA = await fixture.addVote(wallet(), fixture.optionA);
    const voteB = await fixture.addVote(wallet(), fixture.optionB);
    expect(voteA).not.toBe(voteB);
    const result = await beginRefund(fixture.campaignId);
    const serialized = JSON.stringify(result.data ?? {});

    expect(resultKind(result)).toBe("created");
    expect(await countRows("reward_payout_attempts", fixture.campaignId)).toBe(0);
    expect(serialized).not.toMatch(/option_id|selected_option|broadcast|sign|private.?key/i);
    expect((await readRefund(fixture.campaignId))?.transaction_hash).toBeNull();
  });
});
