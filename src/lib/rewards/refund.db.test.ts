import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import {
  createSupabaseRewardRefundStore,
  runRewardRefund,
  type RefundDependencies,
  type RefundSigningContext,
} from "@/lib/rewards/refund";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 42;
const FEE_LUNA = BigInt(4000);
const AMOUNT_LUNA = BigInt(11200);
const PREPARED_HEX = "ab".repeat(32);
const HASH = "cd".repeat(32);
const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureRefundIds: string[] = [];
const fixtureReceiptIds: string[] = [];

type Fixture = {
  pollId: string;
  campaignId: string;
  refundId: string;
  creatorWallet: string;
  vaultAddressHex: string;
  payoutAttemptId: string | null;
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

async function createFixture(options: { withPayoutAttempt?: boolean } = {}): Promise<Fixture> {
  const creatorWallet = wallet();
  const vaultAddressHex = wallet();
  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Refund broadcast ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "closed",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() - 1_000).toISOString(),
    is_public: true,
    published_at: new Date(Date.now() - 86_400_000).toISOString(),
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
    fee_reserve_luna: 1000,
    total_budget_luna: 11000,
    status: options.withPayoutAttempt ? "rewarding" : "refunding",
    funded_amount_luna: 11200,
    refundable_excess_luna: 200,
    paid_amount_luna: 0,
    fee_spent_luna: 0,
    refundable_amount_luna: 11200,
    vault_wallet: vaultAddressHex,
    funded_at: new Date(Date.now() - 86_400_000).toISOString(),
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);

  const { error: vaultError } = await admin.from("reward_campaign_vaults").insert({
    campaign_id: campaign.id,
    vault_address_hex: vaultAddressHex,
    envelope_version: "votum:reward-vault:v1",
    encryption_algorithm: "aes-256-gcm",
    encrypted_private_key_ciphertext: "fixture-ciphertext",
    encryption_iv: "fixture-iv",
    authentication_tag: "fixture-tag",
  });
  if (vaultError) throw vaultError;

  let payoutAttemptId: string | null = null;
  if (options.withPayoutAttempt) {
    const { data: receipt, error: receiptError } = await admin.from("reward_receipts").insert({
      campaign_id: campaign.id,
      poll_id: poll.id,
      participant_wallet: wallet(),
      amount_luna: 1000,
      status: "reserved",
    }).select("id").single();
    if (receiptError || !receipt) throw receiptError ?? new Error("receipt fixture missing");
    fixtureReceiptIds.push(receipt.id);
    const { data: attempt, error: attemptError } = await admin.from("reward_payout_attempts").insert({
      receipt_id: receipt.id,
      attempt_number: 1,
      status: "pending",
    }).select("id").single();
    if (attemptError || !attempt) throw attemptError ?? new Error("attempt fixture missing");
    payoutAttemptId = attempt.id;
  }

  const { data: refund, error: refundError } = await admin.from("reward_refunds").insert({
    campaign_id: campaign.id,
    creator_wallet: creatorWallet,
    amount_luna: Number(AMOUNT_LUNA),
    status: "pending",
  }).select("id").single();
  if (refundError || !refund) throw refundError ?? new Error("refund fixture missing");
  fixtureRefundIds.push(refund.id);

  if (options.withPayoutAttempt) {
    const { error: statusError } = await admin.from("reward_campaigns")
      .update({ status: "refunding" }).eq("id", campaign.id);
    if (statusError) throw statusError;
  }

  return {
    pollId: poll.id,
    campaignId: campaign.id,
    refundId: refund.id,
    creatorWallet,
    vaultAddressHex,
    payoutAttemptId,
  };
}

function cleanupFixtures(): void {
  if (fixtureCampaignIds.length === 0) return;
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  const refunds = fixtureRefundIds.map(sqlQuote).join(", ");
  runPsql(`
    SET session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE campaign_id IN (${campaigns}));
    DELETE FROM public.reward_receipts WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_refunds WHERE id IN (${refunds || "NULL"}) OR campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.polls WHERE id IN (${polls});
    SET session_replication_role = origin;
  `);
  fixturePollIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixtureRefundIds.length = 0;
  fixtureReceiptIds.length = 0;
}

function dependencies(
  overrides: Partial<RefundDependencies> = {},
): RefundDependencies {
  return {
    store: createSupabaseRewardRefundStore(admin),
    createLockToken: randomUUID,
    sign: vi.fn(async (context: RefundSigningContext) => ({
      ...context,
      serializedTransactionHex: PREPARED_HEX,
      transactionHash: HASH,
    })),
    broadcast: vi.fn(async () => ({
      kind: "broadcast" as const,
      transactionHash: HASH.toUpperCase(),
    })),
    getNetworkId: () => NETWORK_ID,
    getFeeLuna: () => FEE_LUNA,
    getValidityStartHeight: async () => 100,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
}

async function readRefund(refundId: string) {
  const { data, error } = await admin.from("reward_refunds")
    .select("id, campaign_id, creator_wallet, amount_luna, status, transaction_hash, sender_address_hex, recipient_address_hex, fee_luna, network_id, validity_start_height, prepared_transaction_hex, prepared_transaction_hash, prepared_at, broadcast_started_at, broadcast_at, error_code")
    .eq("id", refundId).single();
  if (error || !data) throw error ?? new Error("refund missing");
  return data;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanupFixtures());
afterAll(() => cleanupFixtures());

describe("V2B.2.11 Phase C database refund boundary", () => {
  it("persists exact sender, recipient, amount, prepared proof, and broadcast hash without finalizing", async () => {
    const fixture = await createFixture();
    const result = await runRewardRefund(
      { refundId: fixture.refundId, campaignId: fixture.campaignId },
      dependencies(),
    );

    expect(result).toEqual({ kind: "broadcasted", refundId: fixture.refundId, transactionHash: HASH });
    expect(await readRefund(fixture.refundId)).toMatchObject({
      campaign_id: fixture.campaignId,
      creator_wallet: fixture.creatorWallet,
      amount_luna: Number(AMOUNT_LUNA),
      status: "pending",
      transaction_hash: HASH,
      sender_address_hex: fixture.vaultAddressHex,
      recipient_address_hex: fixture.creatorWallet,
      fee_luna: Number(FEE_LUNA),
      network_id: NETWORK_ID,
      validity_start_height: 100,
      prepared_transaction_hex: PREPARED_HEX,
      prepared_transaction_hash: HASH,
      error_code: null,
    });
    const { data: campaign, error } = await admin.from("reward_campaigns")
      .select("status, refunded_at").eq("id", fixture.campaignId).single();
    if (error || !campaign) throw error ?? new Error("campaign missing");
    expect(campaign).toEqual({ status: "refunding", refunded_at: null });
  });

  it("does not rebroadcast an unknown outcome and keeps the refund pending", async () => {
    const fixture = await createFixture();
    const broadcast = vi.fn(async () => ({ kind: "unknown" as const, errorCode: "broadcast_timeout" }));
    const deps = dependencies({ broadcast });

    const first = await runRewardRefund(
      { refundId: fixture.refundId, campaignId: fixture.campaignId },
      deps,
    );
    const second = await runRewardRefund(
      { refundId: fixture.refundId, campaignId: fixture.campaignId },
      deps,
    );

    expect(first.kind).toBe("unknown");
    expect(second).toMatchObject({ kind: "unknown", reasonCode: "broadcast_timeout" });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(await readRefund(fixture.refundId)).toMatchObject({
      status: "pending",
      transaction_hash: null,
      broadcast_started_at: expect.any(String),
      broadcast_at: null,
      error_code: "broadcast_timeout",
    });
  });

  it("serializes concurrent executions for the same campaign vault", async () => {
    const fixture = await createFixture();
    let active = 0;
    let maximumActive = 0;
    const broadcast = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      return { kind: "broadcast" as const, transactionHash: HASH };
    });
    const deps = dependencies({ broadcast });

    const results = await Promise.all([
      runRewardRefund({ refundId: fixture.refundId, campaignId: fixture.campaignId }, deps),
      runRewardRefund({ refundId: fixture.refundId, campaignId: fixture.campaignId }, deps),
    ]);

    expect(results.filter((result) => result.kind === "broadcasted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "already_pending")).toHaveLength(1);
    expect(maximumActive).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("blocks payout lock acquisition while the refund owns the shared campaign lease", async () => {
    const fixture = await createFixture({ withPayoutAttempt: true });
    expect(fixture.payoutAttemptId).not.toBeNull();

    const refundLock = await admin.rpc("acquire_reward_refund_vault_lock_atomic", {
      _campaign_id: fixture.campaignId,
      _refund_id: fixture.refundId,
      _lock_token: "refund-lock",
      _lease_seconds: 120,
    });
    expect(refundLock.error).toBeNull();
    expect(refundLock.data).toMatchObject({ result_kind: "acquired" });

    const payoutLock = await admin.rpc("acquire_reward_payout_vault_lock_atomic", {
      _campaign_id: fixture.campaignId,
      _attempt_id: fixture.payoutAttemptId!,
      _lock_token: "payout-lock",
      _lease_seconds: 120,
    });
    expect(payoutLock.error).toBeNull();
    expect(payoutLock.data).toMatchObject({ result_kind: "busy" });

    const release = await admin.rpc("release_reward_payout_vault_lock_atomic", {
      _campaign_id: fixture.campaignId,
      _lock_token: "refund-lock",
    });
    expect(release.error).toBeNull();
  });
});
