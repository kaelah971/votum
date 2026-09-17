import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign } from "@/lib/campaigns/configuration";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function anonClient() {
  const publishable =
    process.env.VOTUM_CLEANROOM_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    "invalid";
  return createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "public" },
  });
}

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];
const createdChallengeIds: string[] = [];

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function catalogOne(sql: string): string {
  return execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
}

async function createCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Claim challenge migration fixture",
    description: null,
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result.campaign;
}

function challengeRow(campaignId: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    campaign_id: campaignId,
    participant_wallet: OWNER,
    nonce_hash: randomBytes(32).toString("hex"),
    action: "campaign_claim",
    version: 1,
    message: `test-claim-message ${randomUUID()}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  if (createdChallengeIds.length > 0) {
    const ids = createdChallengeIds.map((id) => `'${id}'`).join(", ");
    runPsql(`DELETE FROM public.campaign_claim_challenges WHERE id IN (${ids});`);
    createdChallengeIds.length = 0;
  }
  if (createdCampaignIds.length === 0) return;
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.campaign_claim_challenges WHERE campaign_id IN (${campaigns});
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${roots});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${roots});
    COMMIT;
  `);
  createdCampaignIds.length = 0;
  createdRootIds.length = 0;
});

describe("V2C.3C claim challenge storage migration", () => {
  it("creates the server-private table with the approved columns", async () => {
    const columns = catalogOne(`
      SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'campaign_claim_challenges';
    `);
    expect(columns).toContain("id:uuid");
    expect(columns).toContain("campaign_id:uuid");
    expect(columns).toContain("participant_wallet:text");
    expect(columns).toContain("nonce_hash:text");
    expect(columns).toContain("action:text");
    expect(columns).toContain("version:integer");
    expect(columns).toContain("message:text");
    expect(columns).toContain("issued_at:timestamp with time zone");
    expect(columns).toContain("expires_at:timestamp with time zone");
    expect(columns).toContain("consumed_at:timestamp with time zone");
    expect(columns).toContain("created_at:timestamp with time zone");
  });

  it("enforces canonical wallet shape, action, version, and bounded expiry", async () => {
    const checks = catalogOne(`
      SELECT string_agg(conname, ',' ORDER BY conname)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'campaign_claim_challenges' AND c.contype = 'c';
    `);
    for (const name of [
      "campaign_claim_challenges_wallet_shape",
      "campaign_claim_challenges_nonce_hash_not_empty",
      "campaign_claim_challenges_action",
      "campaign_claim_challenges_version",
      "campaign_claim_challenges_message_not_empty",
      "campaign_claim_challenges_expires_after_issued",
    ]) {
      expect(checks.split(",")).toContain(name);
    }

    const indexes = catalogOne(`
      SELECT string_agg(indexname, ',' ORDER BY indexname)
      FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'campaign_claim_challenges';
    `);
    for (const name of [
      "idx_campaign_claim_challenges_campaign",
      "idx_campaign_claim_challenges_wallet_expires",
      "idx_campaign_claim_challenges_unused",
    ]) {
      expect(indexes.split(",")).toContain(name);
    }
    expect(catalogOne(`
      SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'campaign_claim_challenges';
    `)).toBe("t");
  });

  it("rejects inverted, malformed, and non-canonical challenge rows", async () => {
    const campaign = await createCampaign();
    const now = Date.now();

    // Already-expired but well-formed rows remain storable: expiry is
    // enforced at verification time, never by storage.
    const expiredWellformed = await admin.from("campaign_claim_challenges").insert(
      challengeRow(campaign.campaignId, {
        issued_at: new Date(now - 10 * 60 * 1000).toISOString(),
        expires_at: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
    ).select("id").single();
    expect(expiredWellformed.error).toBeNull();
    if (expiredWellformed.data) createdChallengeIds.push(expiredWellformed.data.id);

    const inverted = await admin.from("campaign_claim_challenges").insert(
      challengeRow(campaign.campaignId, {
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now).toISOString(),
      }),
    );
    expect(inverted.error?.code).toBe("23514");

    const nonCanonical = await admin.from("campaign_claim_challenges").insert(
      challengeRow(campaign.campaignId, { participant_wallet: OWNER.toUpperCase() }),
    );
    expect(nonCanonical.error?.code).toBe("23514");

    const wrongAction = await admin.from("campaign_claim_challenges").insert(
      challengeRow(campaign.campaignId, { action: "wallet_verify" }),
    );
    expect(wrongAction.error?.code).toBe("23514");

    const valid = await admin.from("campaign_claim_challenges")
      .insert(challengeRow(campaign.campaignId))
      .select("id")
      .single();
    expect(valid.error).toBeNull();
    if (valid.data) createdChallengeIds.push(valid.data.id);
  });

  it("refuses anonymous reads and writes on challenge storage", async () => {
    const anon = anonClient();
    const read = await anon.from("campaign_claim_challenges").select("id").limit(1);
    expect(read.data ?? []).toEqual([]);

    const write = await anon.from("campaign_claim_challenges").insert(
      challengeRow("00000000-0000-0000-0000-000000000000"),
    );
    expect(write.data).toBeNull();
  });
});
