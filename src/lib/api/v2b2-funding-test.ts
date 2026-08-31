/**
 * V2B.2.4 — campaign funding initiation contract tests.
 *
 * Local-only HTTP/DB coverage for INTENT -> BIND. No Nimiq Pay provider is
 * imported or invoked here, and no chain observation is performed.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b2-funding-test.ts
 */
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
  console.error("REFUSED: effective Supabase URL is not local — aborting before any DB query.");
  process.exit(2);
}

import {
  admin,
  apiGet,
  apiPost,
  createTestSession,
  deleteTestSession,
  randomNimiqHex,
  startNextDev,
  stopNextDev,
} from "./v2b1-dev-server";

function uuid(): string {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5",
  );
}

function cleanupSql(wallets: string[]): void {
  const quoted = wallets.map((wallet) => `'${wallet}'`).join(",");
  execFileSync("docker", [
    "exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres", "-c",
    `
      DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (
        SELECT id FROM public.reward_receipts WHERE participant_wallet IN (${quoted})
      );
      DELETE FROM public.reward_receipts WHERE participant_wallet IN (${quoted});
      DELETE FROM public.reward_refunds WHERE creator_wallet IN (${quoted});
      DELETE FROM public.reward_funding_transactions WHERE creator_wallet IN (${quoted});
      DELETE FROM public.reward_campaign_vaults
      WHERE campaign_id IN (
        SELECT id FROM public.reward_campaigns WHERE creator_wallet IN (${quoted})
      );
      DELETE FROM public.reward_campaigns WHERE creator_wallet IN (${quoted});
      DELETE FROM public.poll_publication_requests WHERE creator_wallet IN (${quoted});
      DELETE FROM public.poll_votes WHERE voter_wallet IN (${quoted});
      DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet IN (${quoted}));
      DELETE FROM public.polls WHERE creator_wallet IN (${quoted});
      DELETE FROM public.wallet_sessions WHERE wallet_address IN (${quoted});
    `,
  ], { stdio: "pipe" });
}

async function publishPoll(
  creator: string,
  cookie: string,
  question: string,
  reward?: { rewardPerParticipant: string; maxRewardedParticipants: number },
) {
  const legacyFields = {
    mode: "creator",
    destinationWallet: creator,
    destinationPurpose: "V2B.2.4 funding test",
    minimumNim: "1",
  };
  const rewardFirstFields = reward
    ? {
        economicModel: "reward_first",
        rewardMode: "rewarded",
      }
    : legacyFields;

  return apiPost("/api/polls/publish", {
    category: "communities",
    format: "decision",
    question,
    description: null,
    options: ["A", "B"],
    ...rewardFirstFields,
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
    idempotencyKey: uuid(),
    ...(reward ? { reward: { fundingMode: "creator", ...reward } } : {}),
  }, cookie);
}

async function run() {
  const creator = randomNimiqHex();
  const other = randomNimiqHex();
  const participant = randomNimiqHex();
  const sessions: string[] = [];
  let publicPollId = "";
  let secondPollId = "";
  let noRewardPollId = "";
  let privatePollId = "";

  try {
    console.log("V2B.2.4 Campaign Funding Initiation Suite");
    check(isLocalSupabaseUrl(url), "effective Supabase URL is local (guard active)");
    await startNextDev();

    const creatorCookie = await createTestSession(creator);
    const otherCookie = await createTestSession(other);
    sessions.push(creatorCookie, otherCookie);

    const noSession = await apiPost(`/api/polls/${uuid()}/reward/funding/intents`, {});
    check(noSession.status === 401, "no session → 401");

    const published = await publishPoll(creator, creatorCookie, "V2B2.4 primary funding?", {
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 200,
    });
    publicPollId = published.data?.poll?.id as string;
    check(published.status === 201, "rewarded public poll exists for funding");
    check(published.data?.reward?.rewardFundingRequired === true, "configured campaign requires funding");

    const nonOwner = await apiPost(`/api/polls/${publicPollId}/reward/funding/intents`, {}, otherCookie);
    check(nonOwner.status === 403, "non-owner intent creation → 403");

    const privatePoll = await admin.from("polls").insert({
      creator_wallet: creator,
      question: "V2B2.4 private funding?",
      description: null,
      mode: "creator_support",
      destination_wallet: creator,
      destination_purpose: "private test",
      min_nim_luna: 100000,
      fairness_mode: "one_wallet_one_vote",
      status: "live",
      is_public: false,
      ends_at: new Date(Date.now() + 86400000).toISOString(),
    }).select("id").single();
    privatePollId = privatePoll.data?.id as string;
    const privateResponse = await apiPost(`/api/polls/${privatePollId}/reward/funding/intents`, {}, creatorCookie);
    check(privateResponse.status === 422, "private poll funding → 422");

    const noReward = await publishPoll(creator, creatorCookie, "V2B2.4 no reward campaign?");
    noRewardPollId = noReward.data?.poll?.id as string;
    const noCampaign = await apiPost(`/api/polls/${noRewardPollId}/reward/funding/intents`, {}, creatorCookie);
    check(noCampaign.status === 404, "poll without reward campaign → 404");

    const configBefore = await apiGet(`/api/polls/${publicPollId}/reward/config`, creatorCookie);
    const config = configBefore.data?.config;
    check(configBefore.status === 200, "creator funding read model → 200");
    check(config?.state === "configured", "campaign starts configured");
    check(config?.funding === null, "no funding intent exists before Fund");
    check(config?.funded === false, "configured campaign is never reported funded");

    const maliciousBody = {
      campaignId: uuid(),
      amountLuna: "1",
      vaultAddressNq: "NQ00 0000 0000 0000 0000 0000 0000 0000 0000",
    };
    const intentResponse = await apiPost(
      `/api/polls/${publicPollId}/reward/funding/intents`,
      maliciousBody,
      creatorCookie,
    );
    const intent = intentResponse.data?.fundingIntent;
    check(intentResponse.status === 201, "configured campaign can begin funding");
    check(intent?.requiredFundingLuna === "11600000", "required amount comes from server accounting");
    check(intent?.rewardPrincipalLuna === "10000000", "intent captures principal separately");
    check(intent?.feeReserveLuna === "1600000", "intent captures fee reserve separately");
    check(intent?.requiredFundingNim === "116 NIM", "intent exposes exact total funding display");
    check(intent?.vaultAddressHex === config?.vaultAddressHex, "intent recipient is persisted campaign vault");
    check(intent?.requiredFundingLuna !== maliciousBody.amountLuna, "client cannot override funding amount");
    check(intent?.vaultAddressNq !== maliciousBody.vaultAddressNq, "client cannot override vault recipient");
    check(intent?.memo === intent?.reference, "funding memo is bounded server reference");

    const intentId = intent?.fundingIntentId as string;
    const campaignRow = await admin.from("reward_campaigns")
      .select("status, funded_amount_luna, funded_at, reward_principal_luna, fee_reserve_luna, total_budget_luna")
      .eq("id", config?.campaignId)
      .single();
    check(campaignRow.data?.status === "funding_pending", "intent atomically moves campaign to funding_pending");
    check(campaignRow.data?.funded_amount_luna === 0, "confirmed funding remains zero");
    check(campaignRow.data?.funded_at === null, "funded_at remains unset");
    check(campaignRow.data?.reward_principal_luna === 10000000, "campaign principal remains exact");
    check(campaignRow.data?.fee_reserve_luna === 1600000, "campaign fee reserve remains exact");
    check(campaignRow.data?.total_budget_luna === 11600000, "campaign total remains exact");

    const fundingRow = await admin.from("reward_funding_transactions")
      .select("campaign_id, amount_luna, reward_principal_luna, fee_reserve_luna, vault_wallet, status, submitted_transaction_hash")
      .eq("id", intentId)
      .single();
    check(fundingRow.data?.campaign_id === config?.campaignId, "intent records campaign id");
    check(fundingRow.data?.amount_luna === 11600000, "intent amount is principal plus fee reserve");
    check(fundingRow.data?.reward_principal_luna === 10000000, "persisted intent principal snapshot exact");
    check(fundingRow.data?.fee_reserve_luna === 1600000, "persisted intent fee snapshot exact");
    check(fundingRow.data?.vault_wallet === config?.vaultAddressHex, "persisted intent vault snapshot exact");
    check(fundingRow.data?.status === "submitted", "intent status is submitted only");
    check(fundingRow.data?.submitted_transaction_hash === null, "intent has no hash before wallet callback");

    const duplicate = await apiPost(`/api/polls/${publicPollId}/reward/funding/intents`, {}, creatorCookie);
    check(duplicate.status === 200, "repeated intent request is idempotent");
    check(duplicate.data?.fundingIntent?.fundingIntentId === intentId, "repeated intent returns same id");
    check(duplicate.data?.fundingIntent?.requiredFundingLuna === "11600000", "repeated intent preserves amount");

    const editAfterLock = await apiPost(`/api/polls/${publicPollId}/reward/config`, {
      rewardPerParticipant: "0.75",
      maxRewardedParticipants: 100,
    }, creatorCookie);
    check(editAfterLock.status === 409, "funding start locks economic terms");

    const secondPublished = await publishPoll(creator, creatorCookie, "V2B2.4 concurrent funding?", {
      rewardPerParticipant: "0.25",
      maxRewardedParticipants: 40,
    });
    secondPollId = secondPublished.data?.poll?.id as string;
    const concurrent = await Promise.all([
      apiPost(`/api/polls/${secondPollId}/reward/funding/intents`, {}, creatorCookie),
      apiPost(`/api/polls/${secondPollId}/reward/funding/intents`, {}, creatorCookie),
    ]);
    check(concurrent.every((response) => response.status === 201 || response.status === 200), "concurrent intent requests return safely");
    check(new Set(concurrent.map((response) => response.data?.fundingIntent?.fundingIntentId)).size === 1, "concurrent intent requests produce one intent");
    const secondRows = await admin.from("reward_funding_transactions").select("id").eq("campaign_id", secondPublished.data?.reward?.campaignId);
    check((secondRows.data ?? []).length === 1, "concurrent intent requests create one active row");

    const txHash = "b".repeat(64);
    const bindPath = `/api/polls/${publicPollId}/reward/funding/intents/${intentId}/bind`;
    const bound = await apiPost(bindPath, { transactionHash: txHash }, creatorCookie);
    check(bound.status === 201, "mocked callback hash binds server-side");
    check(bound.data?.binding?.transactionHash === txHash, "bound response returns normalized hash");
    check(bound.data?.campaignState === "funding_pending", "binding does not advance campaign to funded");

    const replayBind = await apiPost(bindPath, { transactionHash: txHash.toUpperCase() }, creatorCookie);
    check(replayBind.status === 200, "same hash binding is idempotent");
    const conflictingBind = await apiPost(bindPath, { transactionHash: "c".repeat(64) }, creatorCookie);
    check(conflictingBind.status === 409, "different hash for bound intent is rejected");
    const nonOwnerBind = await apiPost(bindPath, { transactionHash: "d".repeat(64) }, otherCookie);
    check(nonOwnerBind.status === 403, "non-owner hash binding → 403");

    const secondIntentId = concurrent[0].data?.fundingIntent?.fundingIntentId as string;
    const duplicateHash = await apiPost(
      `/api/polls/${secondPollId}/reward/funding/intents/${secondIntentId}/bind`,
      { transactionHash: txHash },
      creatorCookie,
    );
    check(duplicateHash.status === 409, "hash reuse across funding records is rejected");

    const afterBind = await apiGet(`/api/polls/${publicPollId}/reward/config`, creatorCookie);
    check(afterBind.data?.config?.state === "funding_pending", "refresh preserves funding_pending state");
    check(afterBind.data?.config?.funding?.status === "submitted", "refresh preserves submitted funding status");
    check(afterBind.data?.config?.funding?.submittedTransactionHash === txHash, "refresh preserves submitted hash");
    check(afterBind.data?.config?.funded === false, "pending read model never reports funded");

    const finalCampaign = await admin.from("reward_campaigns")
      .select("status, funded_amount_luna, funded_at")
      .eq("id", config?.campaignId)
      .single();
    check(finalCampaign.data?.status === "funding_pending", "campaign remains funding_pending after binding");
    check(finalCampaign.data?.funded_amount_luna === 0, "binding does not increment confirmed funding");
    check(finalCampaign.data?.funded_at === null, "binding does not set funded_at");

    const receipts = await admin.from("reward_receipts").select("id").eq("campaign_id", config?.campaignId);
    const payouts = await admin.from("reward_payout_attempts").select("id");
    const refunds = await admin.from("reward_refunds").select("id").eq("campaign_id", config?.campaignId);
    check((receipts.data ?? []).length === 0, "no reward receipt created");
    check((payouts.data ?? []).length === 0, "no payout attempt created");
    check((refunds.data ?? []).length === 0, "no refund created");
  } finally {
    for (const session of sessions) {
      try { await deleteTestSession(session); } catch { /* best effort */ }
    }
    try { cleanupSql([creator, other, participant]); } catch { /* best effort */ }
    stopNextDev();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
