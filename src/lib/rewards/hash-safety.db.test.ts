import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureReceiptIds: string[] = [];
const fixtureAttemptIds: string[] = [];

type Fixture = {
  pollId: string;
  campaignId: string;
  creatorWallet: string;
  vaultAddress: string;
  receiptId: string | null;
};

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function hash(): string {
  return randomBytes(32).toString("hex");
}

async function createFixture(options: { ledger: "funding" | "payout" | "refund" }): Promise<Fixture> {
  const creatorWallet = wallet();
  const vaultAddress = wallet();
  const now = new Date().toISOString();
  const campaignStatus = options.ledger === "funding" ? "funding_pending" : options.ledger === "payout" ? "rewarding" : "refunding";

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Hash safety ${randomUUID()}`,
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
    ends_at: now,
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
    max_rewarded_participants: 1,
    reward_principal_luna: 1000,
    fee_reserve_luna: 0,
    total_budget_luna: 1000,
    status: campaignStatus,
    funded_amount_luna: 1000,
    refundable_amount_luna: options.ledger === "refund" ? 1000 : 0,
    closed_at: options.ledger === "refund" ? now : null,
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

  let receiptId: string | null = null;
  if (options.ledger === "payout") {
    const { data: receipt, error: receiptError } = await admin.from("reward_receipts").insert({
      campaign_id: campaign.id,
      poll_id: poll.id,
      participant_wallet: wallet(),
      amount_luna: 1000,
      status: "payout_pending",
    }).select("id").single();
    if (receiptError || !receipt) throw receiptError ?? new Error("receipt fixture missing");
    receiptId = receipt.id;
    fixtureReceiptIds.push(receipt.id);
  }

  return { pollId: poll.id, campaignId: campaign.id, creatorWallet, vaultAddress, receiptId };
}

async function insertFunding(fixture: Fixture, transactionHash: string) {
  return admin.from("reward_funding_transactions").insert({
    campaign_id: fixture.campaignId,
    creator_wallet: fixture.creatorWallet,
    funder_wallet: fixture.creatorWallet,
    reference: `votum:hash:${randomUUID()}`,
    amount_luna: 1000,
    status: "submitted",
    submitted_transaction_hash: transactionHash,
    reward_principal_luna: 1000,
    fee_reserve_luna: 0,
    vault_wallet: fixture.vaultAddress,
  });
}

async function insertPayout(fixture: Fixture, transactionHash: string) {
  const result = await admin.from("reward_payout_attempts").insert({
    receipt_id: fixture.receiptId!,
    attempt_number: 1,
    status: "pending",
    transaction_hash: transactionHash,
  }).select("id").maybeSingle();
  if (result.data?.id) fixtureAttemptIds.push(result.data.id);
  return result;
}

async function insertRefund(fixture: Fixture, transactionHash: string) {
  return admin.from("reward_refunds").insert({
    campaign_id: fixture.campaignId,
    creator_wallet: fixture.creatorWallet,
    amount_luna: 1000,
    status: "pending",
    transaction_hash: transactionHash,
    sender_address_hex: fixture.vaultAddress,
    recipient_address_hex: fixture.creatorWallet,
    fee_luna: 0,
    network_id: 42,
    validity_start_height: 100,
    prepared_transaction_hex: "cd".repeat(32),
    prepared_transaction_hash: transactionHash,
    prepared_at: new Date().toISOString(),
    broadcast_started_at: new Date().toISOString(),
    broadcast_at: new Date().toISOString(),
  });
}

async function cleanup(): Promise<void> {
  if (fixtureAttemptIds.length > 0) await admin.from("reward_payout_attempts").delete().in("id", fixtureAttemptIds);
  if (fixtureReceiptIds.length > 0) await admin.from("reward_receipts").delete().in("id", fixtureReceiptIds);
  if (fixtureCampaignIds.length > 0) {
    await admin.from("reward_funding_transactions").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_refunds").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaign_vaults").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaigns").delete().in("id", fixtureCampaignIds);
  }
  if (fixturePollIds.length > 0) await admin.from("polls").delete().in("id", fixturePollIds);
  fixtureAttemptIds.length = 0;
  fixtureReceiptIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanup());
afterAll(() => cleanup());

describe("cross-ledger transaction hash safety", () => {
  it("rejects a funding hash reused by payout and refund ledgers", async () => {
    const funding = await createFixture({ ledger: "funding" });
    const payout = await createFixture({ ledger: "payout" });
    const refund = await createFixture({ ledger: "refund" });
    const transactionHash = hash();
    expect((await insertFunding(funding, transactionHash)).error).toBeNull();

    expect((await insertPayout(payout, transactionHash)).error).not.toBeNull();
    expect((await insertRefund(refund, transactionHash)).error).not.toBeNull();
  });

  it("rejects a payout hash reused by funding and refund ledgers", async () => {
    const payout = await createFixture({ ledger: "payout" });
    const funding = await createFixture({ ledger: "funding" });
    const refund = await createFixture({ ledger: "refund" });
    const transactionHash = hash();
    expect((await insertPayout(payout, transactionHash)).error).toBeNull();

    expect((await insertFunding(funding, transactionHash)).error).not.toBeNull();
    expect((await insertRefund(refund, transactionHash)).error).not.toBeNull();
  });

  it("rejects a refund hash reused by funding and payout ledgers", async () => {
    const refund = await createFixture({ ledger: "refund" });
    const funding = await createFixture({ ledger: "funding" });
    const payout = await createFixture({ ledger: "payout" });
    const transactionHash = hash();
    expect((await insertRefund(refund, transactionHash)).error).toBeNull();

    expect((await insertFunding(funding, transactionHash)).error).not.toBeNull();
    expect((await insertPayout(payout, transactionHash)).error).not.toBeNull();
  });

  it("rejects case-variant same-ledger duplicates in funding, payout, and refund", async () => {
    const funding = await createFixture({ ledger: "funding" });
    const secondFunding = await createFixture({ ledger: "funding" });
    const payout = await createFixture({ ledger: "payout" });
    const secondPayout = await createFixture({ ledger: "payout" });
    const refund = await createFixture({ ledger: "refund" });
    const secondRefund = await createFixture({ ledger: "refund" });
    const fundingHash = hash();
    const payoutHash = hash();
    const refundHash = hash();

    expect((await insertFunding(funding, fundingHash)).error).toBeNull();
    expect((await insertFunding(secondFunding, fundingHash.toUpperCase())).error).not.toBeNull();
    expect((await insertPayout(payout, payoutHash)).error).toBeNull();
    expect((await insertPayout(secondPayout, payoutHash.toUpperCase())).error).not.toBeNull();
    expect((await insertRefund(refund, refundHash)).error).toBeNull();
    expect((await insertRefund(secondRefund, refundHash.toUpperCase())).error).not.toBeNull();
  });
});
