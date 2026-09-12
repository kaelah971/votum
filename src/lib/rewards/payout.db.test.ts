import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Transaction } from "@nimiq/core";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import {
  createSupabaseRewardPayoutStore,
  runRewardPayout,
  type PayoutDependencies,
  type PayoutSigningContext,
} from "@/lib/rewards/payout";
import { ESTIMATED_TX_FEE_LUNA } from "@/lib/rewards/constants";
import { buildRewardPayoutTransaction, signRewardPayoutTransaction } from "@/lib/rewards/vault-signing";
import { ensureCampaignVault, withCampaignVaultKey } from "@/lib/rewards/vault-service";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 42;
const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureReceiptIds: string[] = [];

type Fixture = {
  pollId: string;
  campaignId: string;
  vaultAddressHex: string;
  receiptIds: string[];
  participantWallets: string[];
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

function cleanupFixtures(): void {
  if (fixtureCampaignIds.length === 0) return;
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  runPsql(`
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (${fixtureReceiptIds.map(sqlQuote).join(", ") || "NULL"});
    DELETE FROM public.reward_receipts WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_refunds WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.poll_options WHERE poll_id IN (${polls});
    DELETE FROM public.polls WHERE id IN (${polls});
  `);
  fixturePollIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixtureReceiptIds.length = 0;
}

async function createFixture(receiptCount = 1): Promise<Fixture> {
  const creatorWallet = wallet();
  const participantWallets = Array.from({ length: receiptCount }, () => wallet());
  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `V2B2.7 payout ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    is_public: true,
    published_at: new Date().toISOString(),
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");
  fixturePollIds.push(poll.id);

  const rewardPerParticipantLuna = 7500;
  const { data: campaign, error: campaignError } = await admin.from("reward_campaigns").insert({
    poll_id: poll.id,
    creator_wallet: creatorWallet,
    funding_mode: "creator",
    funding_wallet: creatorWallet,
    reward_per_participant_luna: rewardPerParticipantLuna,
    max_rewarded_participants: 10,
    reward_principal_luna: rewardPerParticipantLuna * 10,
    fee_reserve_luna: 80_000,
    total_budget_luna: rewardPerParticipantLuna * 10 + 80_000,
    status: "configured",
    funded_amount_luna: rewardPerParticipantLuna * 10 + 80_000,
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);

  const vault = await ensureCampaignVault(campaign.id);
  const { error: stateError } = await admin.from("reward_campaigns")
    .update({ status: "rewarding" }).eq("id", campaign.id);
  if (stateError) throw stateError;

  const { data: receipts, error: receiptError } = await admin.from("reward_receipts").insert(
    participantWallets.map((participantWallet) => ({
      campaign_id: campaign.id,
      poll_id: poll.id,
      participant_wallet: participantWallet,
      amount_luna: rewardPerParticipantLuna,
      status: "reserved",
    })),
  ).select("id");
  if (receiptError || !receipts || receipts.length !== receiptCount) {
    throw receiptError ?? new Error("receipt fixture missing");
  }
  fixtureReceiptIds.push(...receipts.map((receipt) => receipt.id));

  return {
    pollId: poll.id,
    campaignId: campaign.id,
    vaultAddressHex: vault.vaultAddressHex,
    receiptIds: receipts.map((receipt) => receipt.id),
    participantWallets,
  };
}

function makeDependencies(
  fixture: Fixture,
  overrides: Partial<PayoutDependencies> = {},
): PayoutDependencies {
  const store = createSupabaseRewardPayoutStore(admin);
  const sign = async (context: PayoutSigningContext) => withCampaignVaultKey(
    context.campaignId,
    (keypair) => {
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return {
        ...context,
        serializedTransactionHex: signed.toHex(),
        transactionHash: signed.hash(),
      };
    },
  );

  return {
    store,
    createLockToken: randomUUID,
    sign,
    broadcast: async (serializedTransactionHex) => {
      const tx = Transaction.deserialize(Buffer.from(serializedTransactionHex, "hex"));
      try {
        return { kind: "broadcast" as const, transactionHash: tx.hash() };
      } finally {
        tx.free?.();
      }
    },
    getNetworkId: () => NETWORK_ID,
    getValidityStartHeight: async () => 100,
    sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
}

async function readReceipt(receiptId: string) {
  const result = await admin.from("reward_receipts")
    .select("id, campaign_id, participant_wallet, amount_luna, status, paid_at")
    .eq("id", receiptId).single();
  if (result.error || !result.data) throw result.error ?? new Error("receipt missing");
  return result.data;
}

async function readAttempts(receiptId: string) {
  const result = await admin.from("reward_payout_attempts")
    .select("id, receipt_id, attempt_number, status, transaction_hash, sender_address_hex, recipient_address_hex, amount_luna, fee_luna, network_id, validity_start_height, prepared_transaction_hex, prepared_at, broadcast_started_at, broadcast_at")
    .eq("receipt_id", receiptId).order("attempt_number");
  if (result.error) throw result.error;
  return result.data ?? [];
}

beforeAll(() => {
  assertLocalSupabaseForTests();
  process.env.NIMIQ_NETWORK_ID = String(NETWORK_ID);
});

afterEach(() => cleanupFixtures());
afterAll(() => cleanupFixtures());

describe("V2B.2.7 database payout boundary", () => {
  it("creates exactly one attempt, prepares/signs/broadcasts, stores hash, and stays payout_pending", async () => {
    const fixture = await createFixture();
    const result = await runRewardPayout(
      { receiptId: fixture.receiptIds[0], campaignId: fixture.campaignId },
      makeDependencies(fixture),
    );

    expect(result.kind).toBe("broadcasted");
    const receipt = await readReceipt(fixture.receiptIds[0]);
    const attempts = await readAttempts(fixture.receiptIds[0]);
    expect(receipt).toMatchObject({
      campaign_id: fixture.campaignId,
      participant_wallet: fixture.participantWallets[0],
      amount_luna: 7500,
      status: "payout_pending",
      paid_at: null,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      receipt_id: fixture.receiptIds[0],
      status: "pending",
      sender_address_hex: fixture.vaultAddressHex,
      recipient_address_hex: fixture.participantWallets[0],
      amount_luna: 7500,
      fee_luna: Number(ESTIMATED_TX_FEE_LUNA),
      network_id: NETWORK_ID,
      validity_start_height: 100,
    });
    expect(attempts[0].prepared_transaction_hex).toMatch(/^[0-9a-f]+$/);
    expect(attempts[0].transaction_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempts[0].prepared_at).not.toBeNull();
    expect(attempts[0].broadcast_started_at).not.toBeNull();
    expect(attempts[0].broadcast_at).not.toBeNull();
    expect(receipt.status).not.toBe("paid");
  });

  it("uses no selected-option data and creates no refund row", async () => {
    const fixture = await createFixture();
    await runRewardPayout(
      { receiptId: fixture.receiptIds[0], campaignId: fixture.campaignId },
      makeDependencies(fixture),
    );
    const receipt = await readReceipt(fixture.receiptIds[0]);
    expect(Object.keys(receipt)).not.toContain("option_id");
    const refunds = await admin.from("reward_refunds").select("id")
      .eq("campaign_id", fixture.campaignId);
    expect(refunds.error).toBeNull();
    expect(refunds.data).toHaveLength(0);
  });

  it("reuses an existing prepared/broadcast attempt without a second sign or broadcast", async () => {
    const fixture = await createFixture();
    const dependencies = makeDependencies(fixture);
    const sign = vi.fn(dependencies.sign);
    const broadcast = vi.fn(dependencies.broadcast);
    const withSpies = { ...dependencies, sign, broadcast };
    await runRewardPayout({ receiptId: fixture.receiptIds[0], campaignId: fixture.campaignId }, withSpies);
    const replay = await runRewardPayout({ receiptId: fixture.receiptIds[0], campaignId: fixture.campaignId }, withSpies);
    expect(replay.kind).toBe("already_pending");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(await readAttempts(fixture.receiptIds[0])).toHaveLength(1);
  });

  it("serializes two receipts on the same campaign vault", async () => {
    const fixture = await createFixture(2);
    let active = 0;
    let maximumActive = 0;
    const dependencies = makeDependencies(fixture, {
      broadcast: async (hex) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const tx = Transaction.deserialize(Buffer.from(hex, "hex"));
        try {
          return { kind: "broadcast" as const, transactionHash: tx.hash() };
        } finally {
          tx.free?.();
          active--;
        }
      },
    });
    const results = await Promise.all(fixture.receiptIds.map((receiptId) =>
      runRewardPayout({ receiptId, campaignId: fixture.campaignId }, dependencies),
    ));
    expect(results.every((result) => result.kind === "broadcasted")).toBe(true);
    expect(maximumActive).toBe(1);
    expect(await readAttempts(fixture.receiptIds[0])).toHaveLength(1);
    expect(await readAttempts(fixture.receiptIds[1])).toHaveLength(1);
  });

  it("allows different campaign vaults to proceed independently", async () => {
    const first = await createFixture();
    const second = await createFixture();
    let active = 0;
    let maximumActive = 0;
    const make = (fixture: Fixture) => makeDependencies(fixture, {
      broadcast: async (hex) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const tx = Transaction.deserialize(Buffer.from(hex, "hex"));
        try {
          return { kind: "broadcast" as const, transactionHash: tx.hash() };
        } finally {
          tx.free?.();
          active--;
        }
      },
    });
    await Promise.all([
      runRewardPayout({ receiptId: first.receiptIds[0], campaignId: first.campaignId }, make(first)),
      runRewardPayout({ receiptId: second.receiptIds[0], campaignId: second.campaignId }, make(second)),
    ]);
    expect(maximumActive).toBe(2);
  });

  it("does not allow a browser-shaped RPC call to override payout terms", async () => {
    const fixture = await createFixture();
    const result = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: fixture.receiptIds[0],
      _campaign_id: fixture.campaignId,
      _amount_luna: 1,
      _recipient_address_hex: wallet(),
    });
    expect(result.error).not.toBeNull();
    expect(await readAttempts(fixture.receiptIds[0])).toHaveLength(0);
    expect((await readReceipt(fixture.receiptIds[0])).status).toBe("reserved");
  });
});
