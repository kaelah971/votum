import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Address } from "@nimiq/core";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import {
  createDefaultRefundReconciliationDependencies,
  loadRefundReconciliationContext,
  reconcileRefund,
  type RefundReconciliationDependencies,
} from "@/lib/rewards/refund-reconciliation";
import type { FundingObservation, ObservedFundingTransaction } from "@/lib/rewards/reconciliation";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 42;
const AMOUNT_LUNA = 11200;
const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureRefundIds: string[] = [];

type Fixture = {
  pollId: string;
  campaignId: string;
  refundId: string;
  creatorWallet: string;
  vaultAddress: string;
  transactionHash: string;
};

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function hash(): string {
  return randomBytes(32).toString("hex");
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

async function createFixture(): Promise<Fixture> {
  const creatorWallet = wallet();
  const vaultAddress = wallet();
  const transactionHash = hash();
  const now = new Date().toISOString();
  const startedAt = new Date(Date.now() - 86_400_000).toISOString();

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Refund reconciliation ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "closed",
    starts_at: startedAt,
    ends_at: now,
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
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 10,
    reward_principal_luna: 10000,
    fee_reserve_luna: 1200,
    total_budget_luna: 11200,
    status: "refunding",
    funded_amount_luna: 11200,
    refundable_excess_luna: 0,
    refundable_amount_luna: AMOUNT_LUNA,
    closed_at: now,
    funded_at: now,
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

  const { data: refund, error: refundError } = await admin.from("reward_refunds").insert({
    campaign_id: campaign.id,
    creator_wallet: creatorWallet,
    amount_luna: AMOUNT_LUNA,
    status: "pending",
    transaction_hash: transactionHash,
    sender_address_hex: vaultAddress,
    recipient_address_hex: creatorWallet,
    fee_luna: 4000,
    network_id: NETWORK_ID,
    validity_start_height: 100,
    prepared_transaction_hex: "cd".repeat(32),
    prepared_transaction_hash: transactionHash,
    prepared_at: now,
    broadcast_started_at: now,
    broadcast_at: now,
  }).select("id").single();
  if (refundError || !refund) throw refundError ?? new Error("refund fixture missing");
  fixtureRefundIds.push(refund.id);

  return {
    pollId: poll.id,
    campaignId: campaign.id,
    refundId: refund.id,
    creatorWallet,
    vaultAddress,
    transactionHash,
  };
}

function cleanup(): void {
  if (fixtureCampaignIds.length === 0) return;
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  const refunds = fixtureRefundIds.map(sqlQuote).join(", ");
  runPsql(`
    SET session_replication_role = replica;
    DELETE FROM public.reward_refunds WHERE id IN (${refunds || "NULL"}) OR campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.polls WHERE id IN (${polls});
    SET session_replication_role = origin;
  `);
  fixturePollIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixtureRefundIds.length = 0;
}

function finalObservation(fixture: Fixture, overrides: Partial<ObservedFundingTransaction> = {}): FundingObservation {
  return {
    kind: "found",
    transaction: {
      transactionHash: fixture.transactionHash,
      blockHash: null,
      networkId: NETWORK_ID,
      sender: fixture.vaultAddress,
      recipient: Address.fromString(fixture.creatorWallet).toUserFriendlyAddress(),
      valueLuna: BigInt(AMOUNT_LUNA),
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
        canonicalBlockHash: "e".repeat(64),
        canonicalBlockVerified: true,
        batchNumber: 7,
        finalizingMacroBlockHeight: 105,
        finalizingMacroBlockHash: "f".repeat(64),
      },
      ...overrides,
    },
  };
}

function dependencies(
  fixture: Fixture,
  overrides: Partial<RefundReconciliationDependencies> = {},
): RefundReconciliationDependencies {
  return {
    ...createDefaultRefundReconciliationDependencies(admin),
    observeRefundByHash: vi.fn(async () => finalObservation(fixture)),
    ...overrides,
  };
}

async function readState(fixture: Fixture) {
  const [{ data: refund, error: refundError }, { data: campaign, error: campaignError }] = await Promise.all([
    admin.from("reward_refunds").select("status, transaction_hash, block_number, transaction_timestamp, confirmed_at, confirmed_network_id, confirmed_transaction_block_hash, confirmed_canonical_block_hash, confirmed_batch_number, confirmed_finalizing_macro_block_height, confirmed_finalizing_macro_block_hash, updated_at").eq("id", fixture.refundId).single(),
    admin.from("reward_campaigns").select("status, refundable_amount_luna, refunded_at, closed_at, paid_amount_luna, fee_spent_luna").eq("id", fixture.campaignId).single(),
  ]);
  if (refundError || campaignError) throw refundError ?? campaignError;
  return { refund, campaign };
}

async function contextFor(fixture: Fixture, viewerWallet?: string) {
  const loaded = await loadRefundReconciliationContext(admin, fixture.pollId, fixture.refundId, viewerWallet);
  if (loaded.kind !== "ok") throw new Error(`fixture context failed: ${loaded.kind}`);
  return loaded.context;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanup());
afterAll(() => cleanup());

describe("V2B.2.11 Phase D local refund reconciliation", () => {
  it("confirms one exact finalized refund and persists all finality evidence", async () => {
    const fixture = await createFixture();
    const result = await reconcileRefund(await contextFor(fixture, fixture.creatorWallet), dependencies(fixture));

    expect(result.kind).toBe("confirmed");
    expect(await readState(fixture)).toMatchObject({
      refund: {
        status: "confirmed",
        transaction_hash: fixture.transactionHash,
        block_number: 100,
        confirmed_network_id: NETWORK_ID,
        confirmed_canonical_block_hash: "e".repeat(64),
        confirmed_batch_number: 7,
        confirmed_finalizing_macro_block_height: 105,
        confirmed_finalizing_macro_block_hash: "f".repeat(64),
      },
      campaign: {
        status: "refunded",
        refundable_amount_luna: AMOUNT_LUNA,
        paid_amount_luna: 0,
        fee_spent_luna: 0,
      },
    });
    expect((await readState(fixture)).refund?.confirmed_at).not.toBeNull();
    expect((await readState(fixture)).campaign?.refunded_at).not.toBeNull();
  });

  it("replays without rewriting timestamps or refund accounting", async () => {
    const fixture = await createFixture();
    const first = await reconcileRefund(await contextFor(fixture, fixture.creatorWallet), dependencies(fixture));
    const before = await readState(fixture);
    const observe = vi.fn(async () => finalObservation(fixture));
    const second = await reconcileRefund(
      await contextFor(fixture, fixture.creatorWallet),
      dependencies(fixture, { observeRefundByHash: observe }),
    );
    const after = await readState(fixture);

    expect(first.kind).toBe("confirmed");
    expect(second.kind).toBe("replay");
    expect(observe).not.toHaveBeenCalled();
    expect(after.refund?.confirmed_at).toBe(before.refund?.confirmed_at);
    expect(after.campaign?.refunded_at).toBe(before.campaign?.refunded_at);
    expect(after.campaign?.status).toBe("refunded");
  });

  it("leaves a non-final refund pending and campaign refunding", async () => {
    const fixture = await createFixture();
    const result = await reconcileRefund(await contextFor(fixture, fixture.creatorWallet), dependencies(fixture, {
      observeRefundByHash: vi.fn(async () => finalObservation(fixture, {
        finality: "not_final",
        finalityReason: "observed_not_final",
      })),
    }));
    expect(result).toMatchObject({ kind: "reconciled", decision: { status: "pending" } });
    expect(await readState(fixture)).toMatchObject({
      refund: { status: "pending" },
      campaign: { status: "refunding", refunded_at: null },
    });
  });

  it("rejects a non-creator viewer without observing or mutating", async () => {
    const fixture = await createFixture();
    const loaded = await loadRefundReconciliationContext(admin, fixture.pollId, fixture.refundId, wallet());
    expect(loaded).toEqual({ kind: "forbidden" });
    expect((await readState(fixture)).campaign?.status).toBe("refunding");
  });

  it("allows an internal admin job context without a viewer wallet", async () => {
    const fixture = await createFixture();
    expect((await contextFor(fixture)).creatorWallet).toBe(fixture.creatorWallet);
  });

  it("rejects wrong atomic proof pairing without mutation", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const result = await admin.rpc("confirm_reward_refund_atomic", {
      _refund_id: fixture.refundId,
      _campaign_id: other.campaignId,
      _transaction_hash: fixture.transactionHash,
      _network_id: NETWORK_ID,
      _observed_sender: fixture.vaultAddress,
      _observed_recipient: fixture.creatorWallet,
      _observed_amount_luna: AMOUNT_LUNA,
      _execution_result: true,
      _block_number: 100,
      _transaction_timestamp: "2026-09-12T00:00:00.000Z",
      _transaction_block_hash: null,
      _canonical_block_hash: "e".repeat(64),
      _batch_number: 7,
      _finalizing_macro_block_height: 105,
      _finalizing_macro_block_hash: "f".repeat(64),
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ result_kind: "refund_campaign_mismatch" });
    expect(await readState(fixture)).toMatchObject({
      refund: { status: "pending" },
      campaign: { status: "refunding" },
    });
  });

  it("serializes concurrent confirmation and performs one terminal transition", async () => {
    const fixture = await createFixture();
    const context = await contextFor(fixture, fixture.creatorWallet);
    const deps = dependencies(fixture);
    const results = await Promise.all([
      reconcileRefund(context, deps),
      reconcileRefund(context, deps),
    ]);
    const state = await readState(fixture);

    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "replay" || result.kind === "busy")).toHaveLength(1);
    expect(state.refund?.status).toBe("confirmed");
    expect(state.campaign?.status).toBe("refunded");
  });

  it("freezes confirmed refund and refunded campaign mutations", async () => {
    const fixture = await createFixture();
    await reconcileRefund(await contextFor(fixture, fixture.creatorWallet), dependencies(fixture));

    const refundUpdate = await admin.from("reward_refunds")
      .update({ error_code: "tampered" }).eq("id", fixture.refundId);
    const campaignUpdate = await admin.from("reward_campaigns")
      .update({ status: "refunding" }).eq("id", fixture.campaignId);

    expect(refundUpdate.error).not.toBeNull();
    expect(campaignUpdate.error).not.toBeNull();
    expect(await readState(fixture)).toMatchObject({
      refund: { status: "confirmed" },
      campaign: { status: "refunded" },
    });
  });
});
