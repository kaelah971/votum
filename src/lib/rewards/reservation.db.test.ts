import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const REWARD_PER_PARTICIPANT = 5000;
const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureWallets: string[] = [];

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec",
    "supabase_db_votum",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ], { stdio: "pipe" });
}

async function claim(
  participationId: string,
  campaignId: string,
  extra: Record<string, unknown> = {},
): Promise<RpcResult> {
  const { data, error } = await admin.rpc("claim_reward_receipt_atomic", {
    _participation_id: participationId,
    _campaign_id: campaignId,
    ...extra,
  });
  return { data, error };
}

function resultKind(result: RpcResult): string | null {
  const data = result.data;
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>).result_kind;
  return typeof value === "string" ? value : null;
}

interface Fixture {
  pollId: string;
  campaignId: string;
  participationId: string;
  optionA: string;
  optionB: string;
  creatorWallet: string;
  participantWallet: string;
  addVote: (participantWallet: string, optionId?: string) => Promise<string>;
}

async function createFixture(options: {
  pollEconomicModel?: "legacy_support" | "reward_first";
  rewardMode?: "free" | "rewarded" | null;
  isPublic?: boolean;
  pollStatus?: "live" | "closed";
  campaignStatus?: string;
  maxRewardedParticipants?: number;
  rewardedParticipantCount?: number;
  firstReservationAt?: string | null;
  rewardPerParticipantLuna?: number;
  creatorWallet?: string;
  participantWallet?: string;
} = {}): Promise<Fixture> {
  const creatorWallet = options.creatorWallet ?? wallet();
  const participantWallet = options.participantWallet ?? wallet();
  fixtureWallets.push(creatorWallet, participantWallet);
  const question = `Reservation fixture ${randomUUID()}`;

  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question,
    description: null,
    economic_model: options.pollEconomicModel ?? "reward_first",
    reward_mode: options.rewardMode === undefined ? "rewarded" : options.rewardMode,
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: options.pollStatus ?? "live",
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    is_public: options.isPublic ?? true,
    published_at: new Date().toISOString(),
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");
  fixturePollIds.push(poll.id);

  const { data: optionsRows, error: optionsError } = await admin
    .from("poll_options")
    .insert([
      { poll_id: poll.id, label: "Option A", sort_order: 0 },
      { poll_id: poll.id, label: "Option B", sort_order: 1 },
    ])
    .select("id, label");
  if (optionsError || !optionsRows || optionsRows.length !== 2) {
    throw optionsError ?? new Error("poll option fixture missing");
  }
  optionsRows.sort((left, right) => left.label.localeCompare(right.label));
  const fixtureOptions = optionsRows;
  const fixturePollId = poll.id;

  const maxRewardedParticipants = options.maxRewardedParticipants ?? 3;
  const rewardPerParticipantLuna = options.rewardPerParticipantLuna ?? REWARD_PER_PARTICIPANT;
  const rewardPrincipalLuna = rewardPerParticipantLuna * maxRewardedParticipants;
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
      fee_reserve_luna: 0,
      total_budget_luna: rewardPrincipalLuna,
      status: options.campaignStatus ?? "funded",
      funded_amount_luna: rewardPrincipalLuna,
      first_reservation_at: options.firstReservationAt ?? null,
    })
    .select("id")
    .single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);

  if (options.rewardedParticipantCount !== undefined || options.campaignStatus === "exhausted") {
    const { error } = await admin.from("reward_campaigns").update({
      rewarded_participant_count: options.rewardedParticipantCount ?? maxRewardedParticipants,
    }).eq("id", campaign.id);
    if (error) throw error;
  }

  async function addVote(voterWallet: string, optionId = fixtureOptions[0].id): Promise<string> {
    fixtureWallets.push(voterWallet);
    const sessionTokenHash = randomBytes(32).toString("hex");
    const sessionError = await admin.from("wallet_sessions").insert({
      token_hash: sessionTokenHash,
      wallet_address: voterWallet,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (sessionError.error) throw sessionError.error;

    const { data: vote, error } = await admin.from("poll_votes").insert({
      poll_id: fixturePollId,
      option_id: optionId,
      voter_wallet: voterWallet,
    }).select("id").single();
    if (error || !vote) throw error ?? new Error("participation fixture missing");
    return vote.id;
  }

  const participationId = await addVote(participantWallet, fixtureOptions[0].id);
  return {
    pollId: poll.id,
    campaignId: campaign.id,
    participationId,
    optionA: fixtureOptions[0].id,
    optionB: fixtureOptions[1].id,
    creatorWallet,
    participantWallet,
    addVote,
  };
}

async function readCampaign(campaignId: string) {
  const { data, error } = await admin.from("reward_campaigns")
    .select("status, rewarded_participant_count, max_rewarded_participants, first_reservation_at")
    .eq("id", campaignId)
    .single();
  if (error || !data) throw error ?? new Error("campaign state missing");
  return data;
}

async function readReceipt(campaignId: string, participantWallet: string) {
  const { data, error } = await admin.from("reward_receipts")
    .select("id, campaign_id, poll_id, participant_wallet, amount_luna, status, created_at, updated_at")
    .eq("campaign_id", campaignId)
    .eq("participant_wallet", participantWallet)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function countRows(table: "reward_receipts" | "reward_payout_attempts" | "reward_refunds", campaignId: string): Promise<number> {
  if (table === "reward_receipts") {
    const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    if (error) throw error;
    return count ?? 0;
  }
  if (table === "reward_refunds") {
    const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
    if (error) throw error;
    return count ?? 0;
  }
  const { data: receipts, error: receiptError } = await admin.from("reward_receipts").select("id").eq("campaign_id", campaignId);
  if (receiptError) throw receiptError;
  if (!receipts || receipts.length === 0) return 0;
  const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).in("receipt_id", receipts.map((receipt) => receipt.id));
  if (error) throw error;
  return count ?? 0;
}

async function cleanupFixtures(): Promise<void> {
  const campaigns = fixtureCampaignIds.map(sqlQuote).join(", ");
  const polls = fixturePollIds.map(sqlQuote).join(", ");
  const wallets = fixtureWallets.map(sqlQuote).join(", ");
  if (!campaigns && !polls && !wallets) return;

  runPsql(`
    DELETE FROM public.reward_payout_attempts
    WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE campaign_id IN (${campaigns || "NULL"}));
    DELETE FROM public.reward_refunds WHERE campaign_id IN (${campaigns || "NULL"});
    DELETE FROM public.reward_funding_transactions WHERE campaign_id IN (${campaigns || "NULL"});
    DELETE FROM public.reward_receipts WHERE campaign_id IN (${campaigns || "NULL"});
    DELETE FROM public.reward_campaign_vaults WHERE campaign_id IN (${campaigns || "NULL"});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns || "NULL"});
    DELETE FROM public.poll_votes WHERE poll_id IN (${polls || "NULL"});
    DELETE FROM public.poll_options WHERE poll_id IN (${polls || "NULL"});
    DELETE FROM public.polls WHERE id IN (${polls || "NULL"});
    DELETE FROM public.wallet_sessions WHERE wallet_address IN (${wallets || "NULL"});
  `);
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
  fixtureWallets.length = 0;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(async () => {
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
});

describe("claim_reward_receipt_atomic", () => {
  it("reserves one reward for an eligible verified participation", async () => {
    const fixture = await createFixture();
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(result.error).toBeNull();
    expect(resultKind(result)).toBe("reserved");
    expect(await readReceipt(fixture.campaignId, fixture.participantWallet)).toMatchObject({
      campaign_id: fixture.campaignId,
      participant_wallet: fixture.participantWallet,
      amount_luna: REWARD_PER_PARTICIPANT,
      status: "reserved",
    });
  });

  it("uses the authoritative campaign reward amount", async () => {
    const fixture = await createFixture({ rewardPerParticipantLuna: 7500 });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("reserved");
    expect((await readReceipt(fixture.campaignId, fixture.participantWallet))?.amount_luna).toBe(7500);
  });

  it("cannot accept a browser reward amount override", async () => {
    const fixture = await createFixture();
    const result = await claim(fixture.participationId, fixture.campaignId, {
      _reward_amount_luna: 1,
    });

    expect(result.error).not.toBeNull();
    expect(await readReceipt(fixture.campaignId, fixture.participantWallet)).toBeNull();
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(0);
  });

  it("keeps creator participation valid while excluding its reward", async () => {
    const fixture = await createFixture({ participantWallet: undefined });
    const creatorParticipationId = await fixture.addVote(fixture.creatorWallet, fixture.optionA);
    const result = await claim(creatorParticipationId, fixture.campaignId);

    expect(resultKind(result)).toBe("creator_not_reward_eligible");
    expect((await admin.from("poll_votes").select("id").eq("id", creatorParticipationId)).data).toHaveLength(1);
    expect(await readReceipt(fixture.campaignId, fixture.creatorWallet)).toBeNull();
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(0);
  });

  it("gives identical reservation behavior for option A and option B", async () => {
    const fixture = await createFixture();
    const secondParticipationId = await fixture.addVote(wallet(), fixture.optionB);
    const first = await claim(fixture.participationId, fixture.campaignId);
    const second = await claim(secondParticipationId, fixture.campaignId);

    expect(resultKind(first)).toBe("reserved");
    expect(resultKind(second)).toBe("reserved");
    expect((first.data as Record<string, unknown>).amount_luna).toBe(
      (second.data as Record<string, unknown>).amount_luna,
    );
  });

  it("rejects a free poll without creating a reservation", async () => {
    const fixture = await createFixture({ rewardMode: "free" });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("poll_not_rewarded");
    expect(await readReceipt(fixture.campaignId, fixture.participantWallet)).toBeNull();
  });

  it("rejects a non-public poll", async () => {
    const fixture = await createFixture({ isPublic: false });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("poll_not_public");
    expect(await readReceipt(fixture.campaignId, fixture.participantWallet)).toBeNull();
  });

  it("rejects a configured campaign", async () => {
    const fixture = await createFixture({ campaignStatus: "configured" });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("campaign_not_funded");
  });

  it("rejects a funding-pending campaign", async () => {
    const fixture = await createFixture({ campaignStatus: "funding_pending" });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("campaign_not_funded");
  });

  it("allows the first reservation on a funded campaign", async () => {
    const fixture = await createFixture();
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("reserved");
    expect((await readCampaign(fixture.campaignId)).status).toBe("rewarding");
  });

  it("sets first_reservation_at exactly once", async () => {
    const fixture = await createFixture();
    expect((await readCampaign(fixture.campaignId)).first_reservation_at).toBeNull();
    expect(resultKind(await claim(fixture.participationId, fixture.campaignId))).toBe("reserved");
    const firstTimestamp = (await readCampaign(fixture.campaignId)).first_reservation_at;
    expect(firstTimestamp).not.toBeNull();

    const secondParticipationId = await fixture.addVote(wallet(), fixture.optionA);
    expect(resultKind(await claim(secondParticipationId, fixture.campaignId))).toBe("reserved");
    expect((await readCampaign(fixture.campaignId)).first_reservation_at).toBe(firstTimestamp);
  });

  it("does not overwrite first_reservation_at on a later reservation", async () => {
    const original = "2026-09-06T00:00:00.000Z";
    const fixture = await createFixture({ firstReservationAt: original, campaignStatus: "rewarding" });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("reserved");
    expect(new Date((await readCampaign(fixture.campaignId)).first_reservation_at ?? 0).toISOString())
      .toBe(new Date(original).toISOString());
  });

  it("replays the same wallet reservation without incrementing twice", async () => {
    const fixture = await createFixture();
    const first = await claim(fixture.participationId, fixture.campaignId);
    const second = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(first)).toBe("reserved");
    expect(resultKind(second)).toBe("replay");
    expect((second.data as Record<string, unknown>).receipt_id).toBe(
      (first.data as Record<string, unknown>).receipt_id,
    );
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(1);
  });

  it("replays the same participation idempotently", async () => {
    const fixture = await createFixture();
    const first = await claim(fixture.participationId, fixture.campaignId);
    const replay = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(first)).toBe("reserved");
    expect(resultKind(replay)).toBe("replay");
    expect(await countRows("reward_receipts", fixture.campaignId)).toBe(1);
  });

  it("rejects an exhausted campaign", async () => {
    const fixture = await createFixture({ campaignStatus: "exhausted", rewardedParticipantCount: 3 });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("no_reward_capacity");
    expect(await readReceipt(fixture.campaignId, fixture.participantWallet)).toBeNull();
  });

  it("rejects a funded campaign whose count already fills capacity", async () => {
    const fixture = await createFixture({ maxRewardedParticipants: 1, rewardedParticipantCount: 1 });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("no_reward_capacity");
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(1);
  });

  it("marks the final successful reservation exhausted", async () => {
    const fixture = await createFixture({ maxRewardedParticipants: 1 });
    const result = await claim(fixture.participationId, fixture.campaignId);

    expect(resultKind(result)).toBe("reserved");
    expect(await readCampaign(fixture.campaignId)).toMatchObject({
      status: "exhausted",
      rewarded_participant_count: 1,
      max_rewarded_participants: 1,
    });
  });

  it("allows only one of two concurrent final-slot reservations", async () => {
    const fixture = await createFixture({ maxRewardedParticipants: 1 });
    const secondParticipationId = await fixture.addVote(wallet(), fixture.optionB);
    const results = await Promise.all([
      claim(fixture.participationId, fixture.campaignId),
      claim(secondParticipationId, fixture.campaignId),
    ]);

    expect(results.filter((result) => resultKind(result) === "reserved")).toHaveLength(1);
    expect(results.filter((result) => resultKind(result) === "no_reward_capacity")).toHaveLength(1);
    expect(await countRows("reward_receipts", fixture.campaignId)).toBe(1);
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(1);
  });

  it("never lets the reservation count exceed max", async () => {
    const fixture = await createFixture({ maxRewardedParticipants: 2 });
    const secondParticipationId = await fixture.addVote(wallet(), fixture.optionB);
    const thirdParticipationId = await fixture.addVote(wallet(), fixture.optionA);
    await Promise.all([
      claim(fixture.participationId, fixture.campaignId),
      claim(secondParticipationId, fixture.campaignId),
      claim(thirdParticipationId, fixture.campaignId),
    ]);

    const campaign = await readCampaign(fixture.campaignId);
    expect(campaign.rewarded_participant_count).toBe(2);
    expect(campaign.rewarded_participant_count).toBeLessThanOrEqual(campaign.max_rewarded_participants);
  });

  it("rejects an invalid participation id without mutation", async () => {
    const fixture = await createFixture();
    const before = await readCampaign(fixture.campaignId);
    const result = await claim(randomUUID(), fixture.campaignId);

    expect(resultKind(result)).toBe("participation_not_found");
    expect(await readCampaign(fixture.campaignId)).toEqual(before);
    expect(await countRows("reward_receipts", fixture.campaignId)).toBe(0);
  });

  it("rejects participation from a different poll", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const result = await claim(second.participationId, first.campaignId);

    expect(resultKind(result)).toBe("participation_poll_mismatch");
    expect(await countRows("reward_receipts", first.campaignId)).toBe(0);
    expect(await countRows("reward_receipts", second.campaignId)).toBe(0);
  });

  it("rejects a campaign/participation mismatch without mutating either side", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstBefore = await readCampaign(first.campaignId);
    const secondBefore = await readCampaign(second.campaignId);
    const result = await claim(first.participationId, second.campaignId);

    expect(resultKind(result)).toBe("participation_poll_mismatch");
    expect(await readCampaign(first.campaignId)).toEqual(firstBefore);
    expect(await readCampaign(second.campaignId)).toEqual(secondBefore);
  });

  it("replays an existing receipt without changing its amount", async () => {
    const fixture = await createFixture({ rewardPerParticipantLuna: 7500 });
    const { error } = await admin.from("reward_receipts").insert({
      campaign_id: fixture.campaignId,
      poll_id: fixture.pollId,
      participant_wallet: fixture.participantWallet,
      amount_luna: 7500,
      status: "reserved",
    });
    if (error) throw error;

    const result = await claim(fixture.participationId, fixture.campaignId);
    expect(resultKind(result)).toBe("replay");
    expect((await readReceipt(fixture.campaignId, fixture.participantWallet))?.amount_luna).toBe(7500);
    expect((await readCampaign(fixture.campaignId)).rewarded_participant_count).toBe(0);
  });

  it("stores no selected-option data in the reward receipt", async () => {
    const fixture = await createFixture();
    expect(resultKind(await claim(fixture.participationId, fixture.campaignId))).toBe("reserved");
    const receipt = await readReceipt(fixture.campaignId, fixture.participantWallet);

    expect(receipt).not.toBeNull();
    expect(Object.keys(receipt ?? {})).not.toContain("option_id");
    expect(Object.keys(receipt ?? {})).not.toContain("selected_option_id");
  });

  it("creates no payout attempts", async () => {
    const fixture = await createFixture();
    expect(resultKind(await claim(fixture.participationId, fixture.campaignId))).toBe("reserved");

    expect(await countRows("reward_payout_attempts", fixture.campaignId)).toBe(0);
  });

  it("creates no refund rows", async () => {
    const fixture = await createFixture();
    expect(resultKind(await claim(fixture.participationId, fixture.campaignId))).toBe("reserved");

    expect(await countRows("reward_refunds", fixture.campaignId)).toBe(0);
  });

  it("returns only reservation data and invokes no payout path", async () => {
    const fixture = await createFixture();
    const result = await claim(fixture.participationId, fixture.campaignId);
    const serialized = JSON.stringify(result.data ?? {});

    expect(resultKind(result)).toBe("reserved");
    expect(serialized).not.toMatch(/payout|sign|broadcast|private.?key|transaction_hash/i);
  });
});
