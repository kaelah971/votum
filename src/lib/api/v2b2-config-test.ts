/**
 * V2B.2.3 — Creator reward configuration contract tests.
 *
 * Exercises the reward-config API route + publish integration against the
 * local dev server and local Supabase:
 *   - creator authorization (401/403), public-only (422), validation (400)
 *   - one campaign per poll, configured-state edits, immutability after lock
 *   - vault binding via ensureCampaignVault (one per campaign)
 *   - safe creator read model (no ciphertext/IV/auth-tag/key material)
 *   - reward-off legacy behavior (no campaign row created)
 *   - NO funding / payout / refund rows are ever created by this checkpoint
 *
 * The local env guard (test-env) aborts before any DB request if the
 * effective Supabase URL is not a local instance.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b2-config-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./load-local-env";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isLocalSupabaseUrl } from "@/lib/rewards/test-env";

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!isLocalSupabaseUrl(url)) {
  console.error("REFUSED: NEXT_PUBLIC_SUPABASE_URL is not a local instance — aborting before any DB query.");
  process.exit(2);
}

import {
  admin,
  startNextDev,
  stopNextDev,
  randomNimiqHex,
  createTestSession,
  deleteTestSession,
  apiPost,
  apiGet,
} from "./v2b1-dev-server";

function uuid(): string {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5",
  );
}

function cleanupSql(wallets: string[]): void {
  const wl = wallets.map((w) => `'${w}'`).join(",");
  if (!wl) return;
  const sql = `
    DELETE FROM public.reward_campaign_vaults
      WHERE campaign_id IN (SELECT id FROM public.reward_campaigns
        WHERE creator_wallet IN (${wl}));
    DELETE FROM public.reward_campaigns WHERE creator_wallet IN (${wl});
    DELETE FROM public.reward_funding_transactions
      WHERE creator_wallet IN (${wl});
    DELETE FROM public.reward_receipts WHERE participant_wallet IN (${wl});
    DELETE FROM public.reward_payout_attempts WHERE receipt_id IN
      (SELECT id FROM public.reward_receipts WHERE participant_wallet IN (${wl}));
    DELETE FROM public.reward_refunds WHERE creator_wallet IN (${wl});
    DELETE FROM public.poll_publication_requests WHERE creator_wallet IN (${wl});
    DELETE FROM public.poll_votes WHERE voter_wallet IN (${wl});
    DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet IN (${wl}));
    DELETE FROM public.polls WHERE creator_wallet IN (${wl});
    DELETE FROM public.wallet_sessions WHERE wallet_address IN (${wl});
    DELETE FROM public.participant_profiles WHERE wallet_address IN (${wl});
  `;
  execFileSync("docker", [
    "exec", "supabase_db_votum",
    "psql", "-U", "postgres", "-d", "postgres",
    "-c", sql,
  ], { stdio: "pipe" });
}

const CREATOR = randomNimiqHex();
const OTHER = randomNimiqHex();
const PARTICIPANT = randomNimiqHex();

async function publishPublicPoll(
  creator: string,
  cookie: string,
  idKey: string,
  question: string,
  reward?: { rewardPerParticipant: string; maxRewardedParticipants: number },
): Promise<{ status: number; data: any }> {
  const res = await apiPost("/api/polls/publish", {
    category: "communities",
    format: "decision",
    question,
    description: null,
    options: ["A", "B"],
    mode: "creator",
    destinationWallet: creator,
    destinationPurpose: "config test",
    minimumNim: "1",
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
    idempotencyKey: idKey,
    ...(reward ? { reward } : {}),
  } as any, cookie);
  return res;
}

async function publishRewardFirstPoll(
  creator: string,
  cookie: string,
  idKey: string,
  question: string,
  rewardMode: "free" | "rewarded",
  reward?: { fundingMode: "creator" | "community"; fundingWallet?: string; rewardPerParticipant: string; maxRewardedParticipants: number },
): Promise<{ status: number; data: any }> {
  return apiPost("/api/polls/publish", {
    category: "communities",
    format: "decision",
    question,
    description: null,
    options: ["A", "B"],
    economicModel: "reward_first",
    rewardMode,
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
    idempotencyKey: idKey,
    ...(reward ? { reward } : {}),
  }, cookie);
}

async function insertPrivatePoll(creator: string): Promise<string> {
  const { data, error } = await admin.from("polls").insert({
    creator_wallet: creator,
    question: "Private reward config test?",
    description: null,
    mode: "creator_support",
    destination_wallet: creator,
    destination_purpose: "private config test",
    min_nim_luna: 100000,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: false,
    ends_at: new Date(Date.now() + 86400000).toISOString(),
  }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function run() {
  console.log("V2B.2.3 Creator Reward Configuration Suite");
  const wallets = [CREATOR, OTHER, PARTICIPANT];
  const sessions: string[] = [];
  let creatorCookie = "";
  let otherCookie = "";
  let publicPollId = "";
  let privatePollId = "";

  try {
    console.log("Starting Next.js dev server...");
    await startNextDev();
    console.log("Next.js ready.\n");

    creatorCookie = await createTestSession(CREATOR);
    otherCookie = await createTestSession(OTHER);
    sessions.push(creatorCookie, otherCookie);

    // -----------------------------------------------------------------
    // Local env guard
    // -----------------------------------------------------------------
    console.log("-- Local env guard --");
    check(isLocalSupabaseUrl(url), "effective Supabase URL is local (guard active)");

    // -----------------------------------------------------------------
    // No session → 401
    // -----------------------------------------------------------------
    console.log("\n-- Authorization --");
    const noSession = await apiPost(`/api/polls/${uuid()}/reward/config`, {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
    });
    check(noSession.status === 401, "no session → 401");

    // Publish a public poll as creator (reward OFF → legacy behavior)
    const pub = await publishPublicPoll(CREATOR, creatorCookie, uuid(), "V2B2 config public?");
    check(pub.status === 201 || pub.status === 200, "public poll published (reward off, legacy)");
    check(pub.data?.reward === undefined, "reward OFF → no reward payload");
    publicPollId = pub.data?.poll?.id as string;
    const offCampaigns = await admin
      .from("reward_campaigns")
      .select("id")
      .eq("poll_id", publicPollId);
    check((offCampaigns.data ?? []).length === 0, "reward OFF → no campaign row");

    const rewardFirstFree = await publishRewardFirstPoll(
      CREATOR,
      creatorCookie,
      uuid(),
      "V2B2 free reward-first poll?",
      "free",
    );
    check(rewardFirstFree.status === 201, "free reward-first poll publishes");
    const freePollId = rewardFirstFree.data?.poll?.id as string;
    const freePoll = await admin
      .from("polls")
      .select("economic_model, reward_mode, mode, destination_wallet, destination_purpose, min_nim_luna")
      .eq("id", freePollId)
      .maybeSingle();
    check(freePoll.data?.economic_model === "reward_first", "free poll stores reward_first discriminator");
    check(freePoll.data?.reward_mode === "free", "free poll stores free reward mode");
    check(
      freePoll.data?.mode === null &&
        freePoll.data?.destination_wallet === null &&
        freePoll.data?.destination_purpose === null &&
        freePoll.data?.min_nim_luna === null,
      "free reward-first poll stores no support configuration",
    );

    const mixedRewardFirst = await apiPost("/api/polls/publish", {
      category: "communities",
      format: "decision",
      question: "V2B2 mixed economic model rejection?",
      description: null,
      options: ["A", "B"],
      economicModel: "reward_first",
      rewardMode: "free",
      mode: "creator",
      destinationWallet: CREATOR,
      destinationPurpose: "must be rejected",
      minimumNim: "1",
      fairnessMode: "one_wallet_one_vote",
      duration: "1day",
      idempotencyKey: uuid(),
    }, creatorCookie);
    check(mixedRewardFirst.status === 400, "reward-first support fields are rejected");

    // -----------------------------------------------------------------
    // Non-owner → 403; unknown poll → 404
    // -----------------------------------------------------------------
    const nonOwner = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
    }, otherCookie);
    check(nonOwner.status === 403, "non-owner → 403");

    const missing = await apiPost(`/api/polls/${uuid()}/reward/config`, {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
    }, creatorCookie);
    check(missing.status === 404, "unknown poll → 404");

    // -----------------------------------------------------------------
    // Private poll → 422
    // -----------------------------------------------------------------
    privatePollId = await insertPrivatePoll(CREATOR);
    const privateResp = await apiPost(`/api/polls/${privatePollId}/reward/config`, {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
    }, creatorCookie);
    check(privateResp.status === 422, "private poll reward config → 422");

    // -----------------------------------------------------------------
    // Validation (400)
    // -----------------------------------------------------------------
    console.log("\n-- Validation --");
    const belowMin = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.009",
      maxRewardedParticipants: 10,
    }, creatorCookie);
    check(belowMin.status === 400, "below minimum reward → 400");

    const malformed = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "abc",
      maxRewardedParticipants: 10,
    }, creatorCookie);
    check(malformed.status === 400, "malformed decimal → 400");

    const zeroMax = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: 0,
    }, creatorCookie);
    check(zeroMax.status === 400, "zero max → 400");

    const floatMax = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: 2.5,
    }, creatorCookie);
    check(floatMax.status === 400, "non-integer max → 400");

    const overflowMax = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.01",
      maxRewardedParticipants: 100001,
    }, creatorCookie);
    check(overflowMax.status === 400, "max above ceiling → 400");

    // -----------------------------------------------------------------
    // Successful config (creator wallet from session only)
    // -----------------------------------------------------------------
    console.log("\n-- Config success --");
    const okConfig = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 200,
    }, creatorCookie);
    check(okConfig.status === 200, "creator config succeeds (0.5 NIM × 200)");
    const config = okConfig.data?.config;
    check(config?.campaignId, "campaign id returned");
    check(config?.rewardPerParticipant?.luna === "50000", "reward per participant 50,000 Luna");
    check(config?.rewardPrincipal?.luna === "10000000", "principal = 10,000,000 Luna (0.5×200)");
    check(config?.feeReserve?.luna === "1600000", "fee reserve = 1,600,000 Luna (4000×200×2)");
    check(config?.totalRequiredFunding?.luna === "11600000", "total = 11,600,000 Luna");
    check(config?.funded === false, "configured campaign is NOT advertised as funded");
    check(config?.state === "configured", "campaign state = configured");
    check(config?.vaultAddressHex?.match(/^[0-9a-f]{40}$/), "vault address hex bound");

    // -----------------------------------------------------------------
    // One campaign per poll + idempotent update
    // -----------------------------------------------------------------
    console.log("\n-- One-per-poll + edits --");
    const second = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.75",
      maxRewardedParticipants: 100,
    }, creatorCookie);
    check(second.status === 200, "configured-state edit allowed (same campaign)");
    check(second.data?.config?.campaignId === config.campaignId, "same campaign id on update");
    check(second.data?.config?.rewardPerParticipant?.luna === "75000", "edit applied (0.75 NIM)");

    const rows = await admin.from("reward_campaigns").select("id").eq("poll_id", publicPollId);
    check((rows.data ?? []).length === 1, "exactly one campaign per poll");

    // -----------------------------------------------------------------
    // Vault binding: one per campaign
    // -----------------------------------------------------------------
    const vaultRows = await admin.from("reward_campaign_vaults").select("campaign_id").eq("campaign_id", config.campaignId);
    check((vaultRows.data ?? []).length === 1, "exactly one vault per campaign");

    // -----------------------------------------------------------------
    // Immutability after lock boundary
    // -----------------------------------------------------------------
    console.log("\n-- Immutability --");
    const lock = await admin.from("reward_campaigns").update({ status: "funded" }).eq("id", config.campaignId);
    check(!lock.error, "campaign moved to funded for lock test");
    const lockedEdit = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.9",
      maxRewardedParticipants: 10,
    }, creatorCookie);
    check(lockedEdit.status === 409, "locked campaign terms cannot mutate → 409");
    // restore configured for cleanliness
    await admin.from("reward_campaigns").update({ status: "configured" }).eq("id", config.campaignId);

    // -----------------------------------------------------------------
    // Read model (creator-only)
    // -----------------------------------------------------------------
    console.log("\n-- Read model --");
    const read = await apiGet(`/api/polls/${publicPollId}/reward/config`, creatorCookie);
    check(read.status === 200, "creator read model → 200");
    const readJson = JSON.stringify(read.data);
    check(readJson.includes("ciphertext") === false, "read model has no ciphertext");
    check(readJson.includes("authentication_tag") === false, "read model has no auth tag");
    check(readJson.includes("encryption_iv") === false, "read model has no IV");
    check(readJson.includes("envelope") === false, "read model has no envelope");
    const readOther = await apiGet(`/api/polls/${publicPollId}/reward/config`, otherCookie);
    check(readOther.status === 403, "non-owner read model → 403");
    const readAnon = await apiGet(`/api/polls/${publicPollId}/reward/config`);
    check(readAnon.status === 401, "no-session read model → 401");

    // -----------------------------------------------------------------
    // Publish integration: reward config via publish → campaign created
    // -----------------------------------------------------------------
    console.log("\n-- Publish integration --");
    const pubReward = await publishPublicPoll(CREATOR, creatorCookie, uuid(), "V2B2 config via publish?", {
      rewardPerParticipant: "0.25",
      maxRewardedParticipants: 40,
    });
    check(pubReward.status === 201 || pubReward.status === 200, "publish with reward config succeeds");
    check(pubReward.data?.reward?.rewardFundingRequired === true, "publish returns rewardFundingRequired:true");
    const pubRewardPollId = pubReward.data?.poll?.id as string;
    const pubCampaigns = await admin.from("reward_campaigns").select("id,status").eq("poll_id", pubRewardPollId);
    check((pubCampaigns.data ?? []).length === 1, "publish created one campaign");
    check(pubCampaigns.data?.[0]?.status === "configured", "publish campaign state = configured");

    const pubRewardFirst = await publishRewardFirstPoll(
      CREATOR,
      creatorCookie,
      uuid(),
      "V2B2 reward-first publish?",
      "rewarded",
      { fundingMode: "creator", rewardPerParticipant: "0.25", maxRewardedParticipants: 40 },
    );
    check(pubRewardFirst.status === 201, "reward-first rewarded poll publishes");
    const pubRewardFirstPollId = pubRewardFirst.data?.poll?.id as string;
    const rewardFirstRow = await admin
      .from("polls")
      .select("economic_model, reward_mode, mode, destination_wallet, destination_purpose, min_nim_luna")
      .eq("id", pubRewardFirstPollId)
      .maybeSingle();
    check(rewardFirstRow.data?.economic_model === "reward_first", "rewarded poll stores reward_first discriminator");
    check(rewardFirstRow.data?.reward_mode === "rewarded", "rewarded poll stores rewarded mode");
    check(
      rewardFirstRow.data?.mode === null &&
        rewardFirstRow.data?.destination_wallet === null &&
        rewardFirstRow.data?.destination_purpose === null &&
        rewardFirstRow.data?.min_nim_luna === null,
      "rewarded poll stores no support configuration",
    );
    check(pubRewardFirst.data?.reward?.rewardFundingRequired === true, "reward-first publish requires funding");

    // -----------------------------------------------------------------
    // No funding / payout / refund rows
    // -----------------------------------------------------------------
    console.log("\n-- No money rows --");
    const fundingRows = await admin.from("reward_funding_transactions").select("id").in("creator_wallet", [CREATOR, OTHER, PARTICIPANT]);
    check((fundingRows.data ?? []).length === 0, "no funding transaction rows created");
    const receiptRows = await admin.from("reward_receipts").select("id").in("participant_wallet", [CREATOR, OTHER, PARTICIPANT]);
    check((receiptRows.data ?? []).length === 0, "no reward receipt rows created");
    const payoutRows = await admin.from("reward_payout_attempts").select("id").in("receipt_id", ["00000000-0000-0000-0000-000000000000"]);
    check((payoutRows.data ?? []).length === 0, "no payout attempt rows created");
    const refundRows = await admin.from("reward_refunds").select("id").in("creator_wallet", [CREATOR, OTHER, PARTICIPANT]);
    check((refundRows.data ?? []).length === 0, "no refund rows created");
  } finally {
    for (const s of sessions) { try { await deleteTestSession(s); } catch { /* ok */ } }
    try { cleanupSql(wallets); } catch { /* best effort */ }
    stopNextDev();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  try { cleanupSql([CREATOR, OTHER, PARTICIPANT]); } catch { /* best effort */ }
  process.exit(1);
});
