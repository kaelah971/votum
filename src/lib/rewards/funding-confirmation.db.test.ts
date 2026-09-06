import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const REQUIRED = 9000;
const PRINCIPAL = 9000;
const FEE_RESERVE = 0;
const fixtureCampaignIds: string[] = [];
const fixturePollIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function wallet(): string {
  return "01" + hex(19);
}

function hash(): string {
  return hex(32);
}

interface Fixture {
  campaignId: string;
  pollId: string;
  intentId: string;
  transactionHash: string;
  vaultAddress: string;
}

async function fixture(options: {
  submittedHash?: string | null;
  campaignStatus?: string;
  fundingStatus?: string;
  vaultAddress?: string;
} = {}): Promise<Fixture> {
  const creator = wallet();
  const transactionHash = options.submittedHash === undefined ? hash() : options.submittedHash;
  const vaultAddress = options.vaultAddress ?? wallet();
  const question = `Funding confirmation fixture ${hex(8)}`;

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creator,
    question,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    is_public: true,
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");
  fixturePollIds.push(poll.id);

  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .insert({
      poll_id: poll.id,
      creator_wallet: creator,
      funding_mode: "creator",
      funding_wallet: creator,
      reward_per_participant_luna: 1000,
      max_rewarded_participants: 9,
      reward_principal_luna: PRINCIPAL,
      fee_reserve_luna: FEE_RESERVE,
      total_budget_luna: REQUIRED,
      status: options.campaignStatus ?? "funding_pending",
      vault_wallet: vaultAddress,
    })
    .select("id")
    .single();
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

  const { data: funding, error: fundingError } = await admin
    .from("reward_funding_transactions")
    .insert({
      campaign_id: campaign.id,
      creator_wallet: creator,
      funder_wallet: creator,
      reference: `votum:fund:${hex(8)}`,
      submitted_transaction_hash: transactionHash,
      amount_luna: REQUIRED,
      reward_principal_luna: PRINCIPAL,
      fee_reserve_luna: FEE_RESERVE,
      vault_wallet: vaultAddress,
      status: options.fundingStatus ?? "submitted",
    })
    .select("id")
    .single();
  if (fundingError || !funding) throw fundingError ?? new Error("funding fixture missing");

  return {
    campaignId: campaign.id,
    pollId: poll.id,
    intentId: funding.id,
    transactionHash: transactionHash ?? hash(),
    vaultAddress,
  };
}

async function confirm(
  fixtureValue: Fixture,
  overrides: {
    campaignId?: string;
    intentId?: string;
    transactionHash?: string;
    amount?: number;
    blockNumber?: number;
    timestamp?: string;
  } = {},
) {
  return admin.rpc("confirm_reward_funding_atomic", {
    _campaign_id: overrides.campaignId ?? fixtureValue.campaignId,
    _intent_id: overrides.intentId ?? fixtureValue.intentId,
    _transaction_hash: overrides.transactionHash ?? fixtureValue.transactionHash,
    _observed_amount_luna: overrides.amount ?? REQUIRED,
    _block_number: overrides.blockNumber ?? 100,
    _transaction_timestamp: overrides.timestamp ?? "2026-09-06T00:00:00.000Z",
  });
}

async function readState(value: Fixture) {
  const [{ data: campaign, error: campaignError }, { data: funding, error: fundingError }] = await Promise.all([
    admin.from("reward_campaigns")
      .select("status, funded_amount_luna, refundable_excess_luna, refundable_amount_luna, funded_at")
      .eq("id", value.campaignId)
      .single(),
    admin.from("reward_funding_transactions")
      .select("status, submitted_transaction_hash, confirmed_transaction_hash, block_number, transaction_timestamp, confirmed_at")
      .eq("id", value.intentId)
      .single(),
  ]);
  if (campaignError) throw campaignError;
  if (fundingError) throw fundingError;
  return { campaign, funding };
}

async function cleanup(): Promise<void> {
  if (fixtureCampaignIds.length > 0) {
    await admin.from("reward_funding_transactions").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaign_vaults").delete().in("campaign_id", fixtureCampaignIds);
    await admin.from("reward_campaigns").delete().in("id", fixtureCampaignIds);
  }
  if (fixturePollIds.length > 0) {
    await admin.from("polls").delete().in("id", fixturePollIds);
  }
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(async () => {
  await cleanup();
});

describe("confirm_reward_funding_atomic", () => {
  it("confirms exact finalized funding atomically", async () => {
    const value = await fixture();
    const result = await confirm(value);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ result_kind: "confirmed" });

    const state = await readState(value);
    expect(state.campaign).toMatchObject({
      status: "funded",
      funded_amount_luna: REQUIRED,
      refundable_excess_luna: 0,
      refundable_amount_luna: 0,
    });
    expect(state.campaign.funded_at).not.toBeNull();
    expect(state.funding).toMatchObject({
      status: "confirmed",
      submitted_transaction_hash: value.transactionHash,
      confirmed_transaction_hash: value.transactionHash,
      block_number: 100,
    });
    expect(state.funding.transaction_timestamp).toBe("2026-09-06T00:00:00+00:00");
    expect(state.funding.confirmed_at).not.toBeNull();
  });

  it("accepts overpayment without changing reward terms", async () => {
    const value = await fixture();
    const result = await confirm(value, { amount: 10000 });
    expect(result.data).toMatchObject({
      result_kind: "confirmed",
      observed_amount_luna: "10000",
      refundable_excess_luna: "1000",
    });
    const state = await readState(value);
    expect(state.campaign).toMatchObject({
      status: "funded",
      funded_amount_luna: 10000,
      refundable_excess_luna: 1000,
      refundable_amount_luna: 0,
    });
  });

  it("rejects underpayment without mutation", async () => {
    const value = await fixture();
    const result = await confirm(value, { amount: 8999 });
    expect(result.data).toMatchObject({ result_kind: "amount_underpaid" });
    expect(await readState(value)).toMatchObject({
      campaign: { status: "funding_pending", funded_amount_luna: 0, funded_at: null },
      funding: { status: "submitted", confirmed_transaction_hash: null, confirmed_at: null },
    });
  });

  it("rejects invalid amounts and hashes without mutation", async () => {
    const value = await fixture();
    const invalidAmount = await confirm(value, { amount: -1 });
    expect(invalidAmount.data).toMatchObject({ result_kind: "invalid_amount" });
    const invalidHash = await confirm(value, { transactionHash: "not-a-transaction-hash" });
    expect(invalidHash.data).toMatchObject({ result_kind: "invalid_hash" });
    expect((await readState(value)).campaign).toMatchObject({
      status: "funding_pending",
      funded_amount_luna: 0,
      funded_at: null,
    });
  });

  it("rejects hash mismatch and null-hash intents without mutation", async () => {
    const value = await fixture();
    const mismatch = await confirm(value, { transactionHash: hash() });
    expect(mismatch.data).toMatchObject({ result_kind: "hash_mismatch" });

    const unbound = await fixture({ submittedHash: null });
    const unboundResult = await confirm(unbound);
    expect(unboundResult.data).toMatchObject({ result_kind: "intent_unbound" });
    expect((await readState(unbound)).funding).toMatchObject({
      status: "submitted",
      submitted_transaction_hash: null,
      confirmed_transaction_hash: null,
    });
  });

  it("rejects wrong campaign/intent pairs", async () => {
    const first = await fixture();
    const second = await fixture();
    const result = await confirm(first, { intentId: second.intentId });
    expect(result.data).toMatchObject({ result_kind: "intent_not_found" });
    expect((await readState(first)).campaign.status).toBe("funding_pending");
    expect((await readState(second)).campaign.status).toBe("funding_pending");
  });

  it("replays duplicate confirmation without double accounting", async () => {
    const value = await fixture();
    const first = await confirm(value);
    const second = await confirm(value);
    expect(first.data).toMatchObject({ result_kind: "confirmed" });
    expect(second.data).toMatchObject({ result_kind: "replay" });
    expect((await readState(value)).campaign).toMatchObject({
      status: "funded",
      funded_amount_luna: REQUIRED,
      refundable_excess_luna: 0,
    });
  });

  it("serializes concurrent confirmation calls", async () => {
    const value = await fixture();
    const results = await Promise.all([confirm(value), confirm(value)]);
    expect(results.filter((result) => result.data?.result_kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.data?.result_kind === "replay")).toHaveLength(1);
    expect((await readState(value)).campaign).toMatchObject({
      status: "funded",
      funded_amount_luna: REQUIRED,
    });
  });

  it("does not fund an already-funded campaign with a different hash", async () => {
    const value = await fixture();
    expect((await confirm(value)).data).toMatchObject({ result_kind: "confirmed" });
    const result = await confirm(value, { transactionHash: hash() });
    expect(result.data).toMatchObject({ result_kind: "campaign_state_conflict" });
  });

  it("rejects a vault snapshot mismatch and creates no downstream rows", async () => {
    const value = await fixture({ vaultAddress: wallet() });
    await admin.from("reward_funding_transactions")
      .update({ vault_wallet: wallet() })
      .eq("id", value.intentId);
    const result = await confirm(value);
    expect(result.data).toMatchObject({ result_kind: "vault_mismatch" });
    expect((await readState(value)).campaign.status).toBe("funding_pending");

    const receipts = await admin.from("reward_receipts").select("id").eq("campaign_id", value.campaignId);
    const refunds = await admin.from("reward_refunds").select("id").eq("campaign_id", value.campaignId);
    expect(receipts.data ?? []).toHaveLength(0);
    expect(refunds.data ?? []).toHaveLength(0);
  });

  it("does not create payout rows and keeps Luna values integral", async () => {
    const value = await fixture();
    await confirm(value, { amount: 10001 });
    const receipts = await admin.from("reward_receipts").select("id").eq("campaign_id", value.campaignId);
    const refunds = await admin.from("reward_refunds").select("id").eq("campaign_id", value.campaignId);
    expect(receipts.data ?? []).toHaveLength(0);
    expect(refunds.data ?? []).toHaveLength(0);
    const state = await readState(value);
    expect(Number.isInteger(state.campaign.funded_amount_luna)).toBe(true);
    expect(state.campaign.refundable_excess_luna).toBeGreaterThanOrEqual(0);
  });
});
