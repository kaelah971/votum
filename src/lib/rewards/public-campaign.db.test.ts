import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const adminKey = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, adminKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const fixturePollIds: string[] = [];
const fixtureCampaignIds: string[] = [];

function wallet(): string {
  return "01" + randomBytes(19).toString("hex");
}

async function createPrivateCampaign() {
  const creatorWallet = wallet();
  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: `Private campaign ${randomUUID()}`,
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
    is_public: false,
    published_at: new Date().toISOString(),
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
    status: "funded",
    funded_amount_luna: 1000,
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  fixtureCampaignIds.push(campaign.id);
  return poll.id;
}

async function cleanup(): Promise<void> {
  if (fixtureCampaignIds.length > 0) {
    await admin.from("reward_campaigns").delete().in("id", fixtureCampaignIds);
  }
  if (fixturePollIds.length > 0) {
    await admin.from("polls").delete().in("id", fixturePollIds);
  }
  fixtureCampaignIds.length = 0;
  fixturePollIds.length = 0;
}

function callAsAnon(pollId: string): Record<string, unknown> {
  const output = execFileSync("docker", [
    "exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
    `SET ROLE anon; SELECT public.get_public_reward_campaign('${pollId}')::text;`,
  ], { encoding: "utf8" });
  const jsonLine = output.trim().split(/\r?\n/).at(-1);
  if (!jsonLine) throw new Error("anonymous RPC returned no result");
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterEach(() => cleanup());
afterAll(() => cleanup());

describe("public reward campaign privacy boundary", () => {
  it("does not expose a campaign attached to a private poll to anonymous callers", async () => {
    const pollId = await createPrivateCampaign();
    expect(callAsAnon(pollId)).toMatchObject({ result_kind: "not_found" });
  });
});
