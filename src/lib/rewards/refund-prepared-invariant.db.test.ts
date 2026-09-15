import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests, isLocalSupabaseUrl } from "@/lib/rewards/test-env";
import { attachPollSettlement } from "@/lib/rewards/settlement-fixture";

const url = process.env.VOTUM_CLEANROOM_SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.VOTUM_CLEANROOM_SUPABASE_KEY
  ?? process.env.SUPABASE_SECRET_KEY ?? "";
const dbContainer = process.env.VOTUM_CLEANROOM_DB_CONTAINER
  ?? "supabase_db_votum";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureRefundIds: string[] = [];

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", dbContainer, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

type Fixture = {
  campaignId: string;
  creatorWallet: string;
};

type PreparedFields = {
  sender_address_hex?: string | null;
  recipient_address_hex?: string | null;
  fee_luna?: number | null;
  network_id?: number | null;
  validity_start_height?: number | null;
  prepared_transaction_hex?: string | null;
  prepared_transaction_hash?: string | null;
  prepared_at?: string | null;
};

async function createFixture(): Promise<Fixture> {
  const creatorWallet = wallet();
  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Prepared refund invariant ${randomUUID()}`,
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
    status: "refunding",
    funded_amount_luna: 11200,
    refundable_excess_luna: 200,
    paid_amount_luna: 0,
    fee_spent_luna: 0,
    refundable_amount_luna: 11200,
    vault_wallet: wallet(),
    funded_at: new Date(Date.now() - 86_400_000).toISOString(),
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);
  await attachPollSettlement(admin, campaign.id);

  return { campaignId: campaign.id, creatorWallet };
}

async function insertRefund(fixture: Fixture, fields: PreparedFields = {}) {
  const { data, error } = await admin.from("reward_refunds").insert({
    campaign_id: fixture.campaignId,
    settlement_id: fixture.campaignId,
    creator_wallet: fixture.creatorWallet,
    amount_luna: 11200,
    status: "pending",
    ...fields,
  }).select("id").maybeSingle();
  if (!error && data) fixtureRefundIds.push(data.id);
  return { data, error };
}

function cleanupFixtures(): void {
  if (fixtureCampaignIds.length === 0) return;
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  const refunds = fixtureRefundIds.map(sqlQuote).join(", ");
  runPsql(`
    SET session_replication_role = replica;
    DELETE FROM public.reward_refunds
      WHERE id IN (${refunds || "NULL"}) OR campaign_id IN (${campaigns});
    DELETE FROM public.settlement_source_bindings
      WHERE reward_campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${campaigns});
    DELETE FROM public.polls WHERE id IN (${polls});
    SET session_replication_role = origin;
  `);
  fixturePollIds.length = 0;
  fixtureCampaignIds.length = 0;
  fixtureRefundIds.length = 0;
}

const fullyPrepared: PreparedFields = {
  sender_address_hex: "01" + "11".repeat(19),
  recipient_address_hex: "01" + "22".repeat(19),
  fee_luna: 4000,
  network_id: 42,
  validity_start_height: 100,
  prepared_transaction_hex: "ab".repeat(32),
  prepared_transaction_hash: "cd".repeat(32),
  prepared_at: "2026-09-15T00:00:00.000Z",
};

beforeAll(() => {
  assertLocalSupabaseForTests();
  if (!isLocalSupabaseUrl(url)) {
    throw new Error("integration test refused: effective Supabase URL must be local");
  }
});

afterEach(() => cleanupFixtures());
afterAll(() => cleanupFixtures());

describe("reward refund prepared-field invariant", () => {
  it("allows an entirely unprepared refund", async () => {
    const fixture = await createFixture();
    const result = await insertRefund(fixture);

    expect(result.error).toBeNull();
    expect(result.data?.id).toBeTruthy();
  });

  it("allows a fully prepared refund", async () => {
    const fixture = await createFixture();
    const result = await insertRefund(fixture, fullyPrepared);

    expect(result.error).toBeNull();
    expect(result.data?.id).toBeTruthy();
  });

  it("rejects a hash-null refund with another prepared field populated", async () => {
    const fixture = await createFixture();
    const result = await insertRefund(fixture, {
      prepared_transaction_hex: fullyPrepared.prepared_transaction_hex,
    });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("23514");
  });

  it("rejects a hash-bearing refund with a missing prepared field", async () => {
    const fixture = await createFixture();
    const result = await insertRefund(fixture, {
      sender_address_hex: fullyPrepared.sender_address_hex,
      recipient_address_hex: fullyPrepared.recipient_address_hex,
      fee_luna: fullyPrepared.fee_luna,
      network_id: fullyPrepared.network_id,
      validity_start_height: fullyPrepared.validity_start_height,
      prepared_transaction_hash: fullyPrepared.prepared_transaction_hash,
      prepared_at: fullyPrepared.prepared_at,
    });

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("23514");
  });
});
