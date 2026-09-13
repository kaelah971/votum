import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Address } from "@nimiq/core";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import {
  createDefaultPayoutReconciliationDependencies,
  loadPayoutReconciliationContext,
  reconcilePayoutAttempt,
  type PayoutReconciliationDependencies,
} from "@/lib/rewards/payout-reconciliation";
import type {
  FundingObservation,
  ObservedFundingTransaction,
} from "@/lib/rewards/reconciliation";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 42;
const REWARD = 9000;
const fixtureCampaignIds: string[] = [];
const fixturePollIds: string[] = [];
const fixtureReceiptIds: string[] = [];
const fixtureAttemptIds: string[] = [];

type Fixture = {
  pollId: string;
  campaignId: string;
  receiptId: string;
  attemptId: string;
  vaultAddress: string;
  participantWallet: string;
  transactionHash: string;
};

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function wallet(): string {
  return "01" + hex(19);
}

function hash(): string {
  return hex(32);
}

async function cleanup(): Promise<void> {
  if (fixtureAttemptIds.length > 0) {
    await admin.from("reward_payout_attempts").delete().in("id", fixtureAttemptIds);
  }
  if (fixtureReceiptIds.length > 0) {
    await admin.from("reward_receipts").delete().in("id", fixtureReceiptIds);
  }
  if (fixtureCampaignIds.length > 0) {
    await admin.from("reward_refunds").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaign_vaults").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaigns").delete().in("id", fixtureCampaignIds);
  }
  if (fixturePollIds.length > 0) {
    await admin.from("polls").delete().in("id", fixturePollIds);
  }
  fixtureAttemptIds.length = 0;
  fixtureReceiptIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

async function createFixture(): Promise<Fixture> {
  const creatorWallet = wallet();
  const participantWallet = wallet();
  const vaultAddress = wallet();
  const transactionHash = hash();
  const now = new Date().toISOString();

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Payout reconciliation ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    starts_at: now,
    ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    is_public: true,
    published_at: now,
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");
  fixturePollIds.push(poll.id);

  const { data: campaign, error: campaignError } = await admin.from("reward_campaigns").insert({
    poll_id: poll.id,
    creator_wallet: creatorWallet,
    funding_mode: "creator",
    funding_wallet: creatorWallet,
    reward_per_participant_luna: REWARD,
    max_rewarded_participants: 1,
    reward_principal_luna: REWARD,
    fee_reserve_luna: 80_000,
    total_budget_luna: REWARD + 80_000,
    status: "rewarding",
    funded_amount_luna: REWARD + 80_000,
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);

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

  const { data: receipt, error: receiptError } = await admin.from("reward_receipts").insert({
    campaign_id: campaign.id,
    poll_id: poll.id,
    participant_wallet: participantWallet,
    amount_luna: REWARD,
    status: "payout_pending",
  }).select("id").single();
  if (receiptError || !receipt) throw receiptError ?? new Error("receipt fixture missing");
  fixtureReceiptIds.push(receipt.id);

  const { data: attempt, error: attemptError } = await admin.from("reward_payout_attempts").insert({
    receipt_id: receipt.id,
    attempt_number: 1,
    status: "pending",
    transaction_hash: transactionHash,
    sender_address_hex: vaultAddress,
    recipient_address_hex: participantWallet,
    amount_luna: REWARD,
    fee_luna: 4000,
    network_id: NETWORK_ID,
    validity_start_height: 100,
    prepared_transaction_hex: null,
    broadcast_started_at: now,
    broadcast_at: now,
  }).select("id").single();
  if (attemptError || !attempt) throw attemptError ?? new Error("attempt fixture missing");
  fixtureAttemptIds.push(attempt.id);

  return {
    pollId: poll.id,
    campaignId: campaign.id,
    receiptId: receipt.id,
    attemptId: attempt.id,
    vaultAddress,
    participantWallet,
    transactionHash,
  };
}

function finalObservation(fixture: Fixture, overrides: Partial<ObservedFundingTransaction> = {}): FundingObservation {
  const participantNq = Address.fromString(fixture.participantWallet).toUserFriendlyAddress();
  return {
    kind: "found",
    transaction: {
      transactionHash: fixture.transactionHash,
      blockHash: null,
      networkId: NETWORK_ID,
      sender: fixture.vaultAddress,
      recipient: participantNq,
      valueLuna: BigInt(REWARD),
      memo: null,
      executionResult: true,
      blockHeight: 100,
      timestampMs: 1_725_000_000_000,
      confirmationCount: 0,
      finality: "final",
      finalityReason: null,
      finalityEvidence: {
        transactionBlockHeight: 100,
        transactionBlockHash: null,
        canonicalBlockHash: "c".repeat(64),
        canonicalBlockVerified: true,
        batchNumber: 7,
        finalizingMacroBlockHeight: 105,
        finalizingMacroBlockHash: "d".repeat(64),
      },
      ...overrides,
    },
  };
}

async function contextFor(fixture: Fixture) {
  const loaded = await loadPayoutReconciliationContext(
    admin,
    fixture.campaignId,
    fixture.attemptId,
    fixture.participantWallet,
  );
  if (loaded.kind !== "ok") throw new Error(`fixture context failed: ${loaded.kind}`);
  return loaded.context;
}

function dependencies(
  fixture: Fixture,
  overrides: Partial<PayoutReconciliationDependencies> = {},
): PayoutReconciliationDependencies {
  return {
    ...createDefaultPayoutReconciliationDependencies(admin),
    observePayoutByHash: vi.fn(async () => finalObservation(fixture)),
    ...overrides,
  };
}

async function readState(fixture: Fixture) {
  const [{ data: receipt, error: receiptError }, { data: attempt, error: attemptError }, { data: campaign, error: campaignError }, { data: refunds, error: refundsError }] = await Promise.all([
    admin.from("reward_receipts").select("status, paid_at, amount_luna").eq("id", fixture.receiptId).single(),
    admin.from("reward_payout_attempts").select("status, transaction_hash, confirmed_at, confirmed_network_id, confirmed_block_number, confirmed_canonical_block_hash, confirmed_batch_number, confirmed_finalizing_macro_block_height, confirmed_finalizing_macro_block_hash").eq("id", fixture.attemptId).single(),
    admin.from("reward_campaigns").select("paid_amount_luna").eq("id", fixture.campaignId).single(),
    admin.from("reward_refunds").select("id").eq("campaign_id", fixture.campaignId),
  ]);
  if (receiptError || attemptError || campaignError || refundsError) {
    throw receiptError ?? attemptError ?? campaignError ?? refundsError;
  }
  return { receipt, attempt, campaign, refunds };
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanup());

describe("V2B.2.8 local payout confirmation RPC", () => {
  it("does not load an attempt through an unrelated settlement ID", async () => {
    const fixture = await createFixture();
    const loaded = await loadPayoutReconciliationContext(
      admin,
      randomUUID(),
      fixture.attemptId,
      fixture.participantWallet,
    );

    expect(loaded).toMatchObject({ kind: "not_found", reasonCode: "campaign_not_found" });
  });

  it("marks one exact finalized payout paid and persists finality evidence", async () => {
    const fixture = await createFixture();
    const result = await reconcilePayoutAttempt(await contextFor(fixture), dependencies(fixture));

    expect(result.kind).toBe("confirmed");
    const state = await readState(fixture);
    expect(state.receipt).toMatchObject({ status: "paid", amount_luna: REWARD });
    expect(state.receipt?.paid_at).not.toBeNull();
    expect(state.attempt).toMatchObject({
      status: "confirmed",
      transaction_hash: fixture.transactionHash,
      confirmed_network_id: NETWORK_ID,
      confirmed_block_number: 100,
      confirmed_canonical_block_hash: "c".repeat(64),
      confirmed_batch_number: 7,
      confirmed_finalizing_macro_block_height: 105,
      confirmed_finalizing_macro_block_hash: "d".repeat(64),
    });
    expect(state.campaign?.paid_amount_luna).toBe(REWARD);
    expect(state.refunds).toHaveLength(0);
  });

  it("replays duplicate reconciliation without rewriting timestamps or accounting", async () => {
    const fixture = await createFixture();
    const first = await reconcilePayoutAttempt(await contextFor(fixture), dependencies(fixture));
    const before = await readState(fixture);
    const observe = vi.fn(async () => finalObservation(fixture));
    const second = await reconcilePayoutAttempt(await contextFor(fixture), dependencies(fixture, { observePayoutByHash: observe }));
    const after = await readState(fixture);

    expect(first.kind).toBe("confirmed");
    expect(second.kind).toBe("replay");
    expect(observe).not.toHaveBeenCalled();
    expect(after.receipt?.paid_at).toBe(before.receipt?.paid_at);
    expect(after.attempt?.confirmed_at).toBe(before.attempt?.confirmed_at);
    expect(after.campaign?.paid_amount_luna).toBe(REWARD);
    expect(after.refunds).toHaveLength(0);
  });

  it("leaves a non-final payout pending and unpaid", async () => {
    const fixture = await createFixture();
    const result = await reconcilePayoutAttempt(await contextFor(fixture), dependencies(fixture, {
      observePayoutByHash: vi.fn(async () => finalObservation(fixture, {
        finality: "not_final",
        finalityReason: "observed_not_final",
      })),
    }));

    expect(result).toMatchObject({ kind: "reconciled", decision: { status: "pending" } });
    expect(await readState(fixture)).toMatchObject({
      receipt: { status: "payout_pending", paid_at: null },
      attempt: { status: "pending" },
      campaign: { paid_amount_luna: 0 },
    });
  });

  it("serializes concurrent confirmation and performs one accounting transition", async () => {
    const fixture = await createFixture();
    const context = await contextFor(fixture);
    const dependenciesValue = dependencies(fixture);
    const results = await Promise.all([
      reconcilePayoutAttempt(context, dependenciesValue),
      reconcilePayoutAttempt(context, dependenciesValue),
    ]);
    const state = await readState(fixture);

    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "replay" || result.kind === "busy")).toHaveLength(1);
    expect(state.attempt?.status).toBe("confirmed");
    expect(state.receipt?.status).toBe("paid");
    expect(state.campaign?.paid_amount_luna).toBe(REWARD);
  });

  it("rejects wrong attempt/receipt pairing atomically without mutation", async () => {
    const fixture = await createFixture();
    const context = await contextFor(fixture);
    const result = await admin.rpc("confirm_reward_payout_atomic", {
      _attempt_id: fixture.attemptId,
      _receipt_id: randomUUID(),
      _campaign_id: fixture.campaignId,
      _transaction_hash: fixture.transactionHash,
      _network_id: NETWORK_ID,
      _observed_sender: fixture.vaultAddress,
      _observed_recipient: fixture.participantWallet,
      _observed_amount_luna: REWARD,
      _execution_result: true,
      _block_number: 100,
      _transaction_timestamp: "2026-09-12T00:00:00.000Z",
      _transaction_block_hash: null,
      _canonical_block_hash: "c".repeat(64),
      _batch_number: 7,
      _finalizing_macro_block_height: 105,
      _finalizing_macro_block_hash: "d".repeat(64),
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ result_kind: "attempt_receipt_mismatch" });
    expect(context.receiptStatus).toBe("payout_pending");
    expect(await readState(fixture)).toMatchObject({
      receipt: { status: "payout_pending", paid_at: null },
      attempt: { status: "pending" },
      campaign: { paid_amount_luna: 0 },
    });
  });

  it("keeps the pending attempt and creates no refund rows when the hash is not found", async () => {
    const fixture = await createFixture();
    const result = await reconcilePayoutAttempt(await contextFor(fixture), dependencies(fixture, {
      observePayoutByHash: vi.fn(async () => ({ kind: "not_found" as const })),
    }));
    expect(result).toMatchObject({ kind: "reconciled", decision: { reasonCode: "transaction_not_found_yet" } });
    expect((await readState(fixture)).refunds).toHaveLength(0);
  });

  it("refuses a new attempt while a prior hash still requires reconciliation", async () => {
    const fixture = await createFixture();
    const attemptUpdate = await admin.from("reward_payout_attempts")
      .update({ status: "retryable" }).eq("id", fixture.attemptId);
    const receiptUpdate = await admin.from("reward_receipts")
      .update({ status: "retryable" }).eq("id", fixture.receiptId);
    if (attemptUpdate.error || receiptUpdate.error) throw attemptUpdate.error ?? receiptUpdate.error;

    const result = await admin.rpc("retry_reward_payout_atomic", {
      _receipt_id: fixture.receiptId,
      _campaign_id: fixture.campaignId,
    });
    const attempts = await admin.from("reward_payout_attempts")
      .select("id").eq("receipt_id", fixture.receiptId);

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ result_kind: "reconciliation_required" });
    expect(attempts.data).toHaveLength(1);
    expect((await readState(fixture)).receipt?.status).toBe("retryable");
  });

  it("allows a bounded retry only for a hashless pre-broadcast failure", async () => {
    const fixture = await createFixture();
    const attemptUpdate = await admin.from("reward_payout_attempts")
      .update({
        status: "retryable",
        transaction_hash: null,
        broadcast_started_at: null,
        broadcast_at: null,
      }).eq("id", fixture.attemptId);
    const receiptUpdate = await admin.from("reward_receipts")
      .update({ status: "retryable" }).eq("id", fixture.receiptId);
    if (attemptUpdate.error || receiptUpdate.error) throw attemptUpdate.error ?? receiptUpdate.error;

    const result = await admin.rpc("retry_reward_payout_atomic", {
      _receipt_id: fixture.receiptId,
      _campaign_id: fixture.campaignId,
    });
    const attempts = await admin.from("reward_payout_attempts")
      .select("id, attempt_number, status, transaction_hash").eq("receipt_id", fixture.receiptId)
      .order("attempt_number");

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      result_kind: "retryable",
      attempt_number: 2,
      receipt_status: "payout_pending",
    });
    expect(attempts.data).toHaveLength(2);
    expect(attempts.data?.[1]).toMatchObject({ attempt_number: 2, status: "pending", transaction_hash: null });
    expect((await readState(fixture)).receipt?.status).toBe("payout_pending");
  });
});
