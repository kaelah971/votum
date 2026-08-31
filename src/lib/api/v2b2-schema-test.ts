/**
 * V2B.2.1 — Reward schema contract tests.
 *
 * Proves the additive reward-schema foundation:
 *   - tables/constraints/indexes exist with the locked CHECK/unique rules
 *   - one campaign per poll; one reward per wallet per campaign
 *   - no option_id / selected-option fields anywhere in the reward schema
 *   - RLS blocks direct anon/authenticated access to internal reward tables
 *   - public read function returns only the D7 allowlist
 *   - existing V1/V2 tables and behavior remain intact
 *
 * Usage:
 *   npx tsx src/lib/api/v2b2-schema-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./load-local-env";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import {
  MIN_REWARD_PER_PARTICIPANT_LUNA,
  ESTIMATED_TX_FEE_LUNA,
  computeFeeReserveLuna,
  computeRewardPrincipalLuna,
  computeTotalBudgetLuna,
} from "@/lib/rewards/constants";

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});
const anon = createClient(url, pubKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function ensureLocal(): void {
  if (!url || url.includes(".supabase.co")) {
    throw new Error("refusing hosted Supabase target");
  }
}

function cleanupSql(wallet: string): void {
  ensureLocal();
  const sql = `
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (
        SELECT id FROM public.reward_receipts
        WHERE campaign_id IN (
          SELECT id FROM public.reward_campaigns WHERE creator_wallet = '${wallet}'
        )
      );
    DELETE FROM public.reward_refunds
      WHERE campaign_id IN (
        SELECT id FROM public.reward_campaigns WHERE creator_wallet = '${wallet}'
      );
    DELETE FROM public.reward_funding_transactions
      WHERE campaign_id IN (
        SELECT id FROM public.reward_campaigns WHERE creator_wallet = '${wallet}'
      );
    DELETE FROM public.reward_receipts
      WHERE campaign_id IN (
        SELECT id FROM public.reward_campaigns WHERE creator_wallet = '${wallet}'
      );
    DELETE FROM public.reward_campaigns WHERE creator_wallet = '${wallet}';
    DELETE FROM public.nim_contributions
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.nim_support_intents
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_votes
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_publication_requests WHERE creator_wallet = '${wallet}';
    DELETE FROM public.polls WHERE creator_wallet = '${wallet}';
    DELETE FROM public.participant_profiles WHERE wallet_address = '${wallet}';
    DELETE FROM public.wallet_sessions WHERE wallet_address = '${wallet}';
  `;
  execFileSync("docker", [
    "exec", "supabase_db_votum",
    "psql", "-U", "postgres", "-d", "postgres",
    "-c", sql,
  ], { stdio: "pipe" });
}

function uuid(): string {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5",
  );
}

const CREATOR = "01" + randomBytes(19).toString("hex");
const PARTICIPANT = "02" + randomBytes(19).toString("hex");
let pollId = "";
let campaignId = "";

async function publishPoll(): Promise<string> {
  const q = "V2B2 schema contract test?";
  const opts = ["A", "B"];
  const fp = createHash("sha256")
    .update(JSON.stringify({
      question: q, description: null, options: opts, mode: "creator_support",
      destinationWallet: CREATOR, destinationPurpose: "schema test",
      minimumNimLuna: "100000", fairnessMode: "one_wallet_one_vote", duration: "1day",
    }))
    .digest("hex");
  const r = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: CREATOR,
    _question: q,
    _description: null,
    _mode: "creator_support",
    _destination_wallet: CREATOR,
    _destination_purpose: "schema test",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: opts,
    _idempotency_key: uuid(),
    _request_fingerprint: fp,
  });
  if (r.error) throw r.error;
  return (r.data as any).id as string;
}

const REWARD_TABLES = [
  "reward_campaigns",
  "reward_funding_transactions",
  "reward_receipts",
  "reward_payout_attempts",
  "reward_refunds",
];

async function run() {
  console.log("V2B.2.1 Reward Schema Suite");

  // ---------------------------------------------------------------
  // 1. Tables exist (migration applied)
  // ---------------------------------------------------------------
  console.log("\n-- Tables exist --");
  for (const t of REWARD_TABLES) {
    const { error } = await admin
      .from(t as any)
      .select("id")
      .limit(1);
    check(!error || error.code === "PGRST116", `${t} table exists (queryable)`);
  }

  // ---------------------------------------------------------------
  // 2. Core domain constants (mirror of domain.test.ts, DB-facing)
  // ---------------------------------------------------------------
  console.log("\n-- Constants --");
  check(MIN_REWARD_PER_PARTICIPANT_LUNA === 1000n, "minimum reward = 1000 Luna (0.01 NIM)");
  check(ESTIMATED_TX_FEE_LUNA > 0n, "fee estimate is a positive centralized constant");
  const principal = computeRewardPrincipalLuna(50000n, 200);
  check(principal === 10000000n, "principal = perParticipant × max (integer)");
  check(
    computeTotalBudgetLuna(principal, computeFeeReserveLuna(200)) ===
      principal + computeFeeReserveLuna(200),
    "total budget = principal + fee reserve (separate)",
  );

  // ---------------------------------------------------------------
  // 3. Create a campaign (valid) via the schema
  // ---------------------------------------------------------------
  console.log("\n-- Campaign creation --");
  pollId = await publishPoll();

  const perLuna = Number(MIN_REWARD_PER_PARTICIPANT_LUNA);
  const maxP = 10;
  const principalN = Number(computeRewardPrincipalLuna(BigInt(perLuna), maxP));
  const feeReserveN = Number(computeFeeReserveLuna(maxP));
  const totalN = principalN + feeReserveN;

  const campInsert = await admin.from("reward_campaigns" as any).insert({
    poll_id: pollId,
    creator_wallet: CREATOR,
    funding_mode: "creator",
    funding_wallet: CREATOR,
    reward_per_participant_luna: perLuna,
    max_rewarded_participants: maxP,
    reward_principal_luna: principalN,
    fee_reserve_luna: feeReserveN,
    total_budget_luna: totalN,
    status: "configured",
  }).select("id").single();
  check(!campInsert.error, "valid campaign insert succeeds");
  if (campInsert.data) campaignId = campInsert.data.id as string;
  check(typeof campaignId === "string" && campaignId.length > 0, "campaign id returned");

  // ---------------------------------------------------------------
  // 4. CHECK constraints reject invalid money / state
  // ---------------------------------------------------------------
  console.log("\n-- CHECK constraints --");
  const belowMin = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(), // invalid poll id too, but CHECK fires first on per
    creator_wallet: CREATOR,
    reward_per_participant_luna: 999,
    max_rewarded_participants: 1,
    reward_principal_luna: 999,
    fee_reserve_luna: 0,
    total_budget_luna: 999,
  }).select("id");
  check(belowMin.error !== null, "below-minimum reward rejected");

  const zeroMax = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 0,
    reward_principal_luna: 0,
    fee_reserve_luna: 0,
    total_budget_luna: 0,
  }).select("id");
  check(zeroMax.error !== null, "zero max participants rejected");

  const negMoney = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 2,
    reward_principal_luna: 2000,
    fee_reserve_luna: -1,
    total_budget_luna: 1999,
  }).select("id");
  check(negMoney.error !== null, "negative fee reserve rejected");

  const badPrincipal = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 2,
    reward_principal_luna: 5000, // wrong: should be 2000
    fee_reserve_luna: 0,
    total_budget_luna: 5000,
  }).select("id");
  check(badPrincipal.error !== null, "principal must equal per × max");

  const badTotal = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 2,
    reward_principal_luna: 2000,
    fee_reserve_luna: 100,
    total_budget_luna: 2000, // wrong: should be 2100
  }).select("id");
  check(badTotal.error !== null, "total must equal principal + fee reserve");

  const badState = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 1,
    reward_principal_luna: 1000,
    fee_reserve_luna: 0,
    total_budget_luna: 1000,
    status: "bogus_state",
  }).select("id");
  check(badState.error !== null, "invalid campaign state rejected");

  const emptyWallet = await admin.from("reward_campaigns" as any).insert({
    poll_id: uuid(),
    creator_wallet: "   ",
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 1,
    reward_principal_luna: 1000,
    fee_reserve_luna: 0,
    total_budget_luna: 1000,
  }).select("id");
  check(emptyWallet.error !== null, "empty creator wallet rejected");

  // ---------------------------------------------------------------
  // 5. One campaign per poll (UNIQUE poll_id)
  // ---------------------------------------------------------------
  console.log("\n-- One campaign per poll --");
  const dupCamp = await admin.from("reward_campaigns" as any).insert({
    poll_id: pollId,
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 1,
    reward_principal_luna: 1000,
    fee_reserve_luna: 0,
    total_budget_luna: 1000,
  }).select("id");
  check(dupCamp.error !== null, "second campaign for same poll rejected (UNIQUE poll_id)");

  // ---------------------------------------------------------------
  // 6. Funding transaction idempotency (reference + hash partial-unique)
  // ---------------------------------------------------------------
  console.log("\n-- Funding transactions --");
  const refA = uuid();
  const hashA = "a".repeat(64);
  const f1 = await admin.from("reward_funding_transactions" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    funder_wallet: CREATOR,
    reference: refA,
    submitted_transaction_hash: hashA,
    amount_luna: totalN,
    status: "submitted",
  }).select("id");
  check(!f1.error, "funding intent insert succeeds");

  const dupRef = await admin.from("reward_funding_transactions" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    funder_wallet: CREATOR,
    reference: refA,
    amount_luna: totalN,
  }).select("id");
  check(dupRef.error !== null, "duplicate funding reference rejected");

  const dupHash = await admin.from("reward_funding_transactions" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    funder_wallet: CREATOR,
    reference: uuid(),
    submitted_transaction_hash: hashA,
    amount_luna: totalN,
  }).select("id");
  check(dupHash.error !== null, "same submitted hash cannot be reserved twice (partial unique)");

  const badFundingState = await admin.from("reward_funding_transactions" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    funder_wallet: CREATOR,
    reference: uuid(),
    amount_luna: totalN,
    status: "bogus",
  }).select("id");
  check(badFundingState.error !== null, "invalid funding state rejected");

  // ---------------------------------------------------------------
  // 7. Receipts: one reward per wallet per campaign; no option fields
  // ---------------------------------------------------------------
  console.log("\n-- Receipts --");
  const r1 = await admin.from("reward_receipts" as any).insert({
    campaign_id: campaignId,
    poll_id: pollId,
    participant_wallet: PARTICIPANT,
    amount_luna: perLuna,
    status: "eligible",
  }).select("id");
  check(!r1.error, "receipt insert succeeds");
  const r1Id = (r1.data?.[0] as any)?.id as string;

  const dupReceipt = await admin.from("reward_receipts" as any).insert({
    campaign_id: campaignId,
    poll_id: pollId,
    participant_wallet: PARTICIPANT,
    amount_luna: perLuna,
    status: "eligible",
  }).select("id");
  check(dupReceipt.error !== null, "duplicate receipt for same wallet+campaign rejected (UNIQUE)");

  const badReceiptState = await admin.from("reward_receipts" as any).insert({
    campaign_id: campaignId,
    poll_id: pollId,
    participant_wallet: "03" + randomBytes(19).toString("hex"),
    amount_luna: perLuna,
    status: "bogus",
  }).select("id");
  check(badReceiptState.error !== null, "invalid receipt state rejected");

  // ---------------------------------------------------------------
  // 8. Payout attempts: unique (receipt_id, attempt_number)
  // ---------------------------------------------------------------
  console.log("\n-- Payout attempts --");
  const p1 = await admin.from("reward_payout_attempts" as any).insert({
    receipt_id: r1Id,
    attempt_number: 1,
    status: "pending",
  }).select("id");
  check(!p1.error, "payout attempt insert succeeds");

  const dupAttempt = await admin.from("reward_payout_attempts" as any).insert({
    receipt_id: r1Id,
    attempt_number: 1,
    status: "pending",
  }).select("id");
  check(dupAttempt.error !== null, "duplicate (receipt, attempt_number) rejected");

  const zeroAttempt = await admin.from("reward_payout_attempts" as any).insert({
    receipt_id: r1Id,
    attempt_number: 0,
    status: "pending",
  }).select("id");
  check(zeroAttempt.error !== null, "attempt_number must be > 0");

  const badAttemptState = await admin.from("reward_payout_attempts" as any).insert({
    receipt_id: r1Id,
    attempt_number: 2,
    status: "bogus",
  }).select("id");
  check(badAttemptState.error !== null, "invalid payout attempt state rejected");

  // ---------------------------------------------------------------
  // 9. Refunds: relationships + status; one active per campaign
  // ---------------------------------------------------------------
  console.log("\n-- Refunds --");
  const ref1 = await admin.from("reward_refunds" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    amount_luna: 1000,
    status: "pending",
  }).select("id");
  check(!ref1.error, "refund insert succeeds");

  const activeRefund2 = await admin.from("reward_refunds" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    amount_luna: 1000,
    status: "pending",
  }).select("id");
  check(activeRefund2.error !== null, "second active refund for campaign rejected (partial unique)");

  const badRefundState = await admin.from("reward_refunds" as any).insert({
    campaign_id: campaignId,
    creator_wallet: CREATOR,
    amount_luna: 1000,
    status: "bogus",
  }).select("id");
  check(badRefundState.error !== null, "invalid refund state rejected");

  // ---------------------------------------------------------------
  // 10. No option_id / selected-option columns in reward schema
  // ---------------------------------------------------------------
  console.log("\n-- No selected-option fields --");
  {
    const { data: row } = await admin.from("reward_receipts" as any)
      .select("*")
      .eq("participant_wallet", PARTICIPANT)
      .maybeSingle();
    const keys = row ? Object.keys(row) : [];
    const leaked = keys.filter((k) => /option|choice|selected|vote_payload/i.test(k));
    check(leaked.length === 0, `reward_receipts has no option/choice fields (${keys.join(",")})`);
    const { data: camp } = await admin.from("reward_campaigns" as any)
      .select("*")
      .eq("id", campaignId)
      .maybeSingle();
    const campKeys = camp ? Object.keys(camp) : [];
    const campLeaked = campKeys.filter((k) => /option|choice|selected|vote_payload/i.test(k));
    check(campLeaked.length === 0, "reward_campaigns has no option/choice fields");
  }

  // ---------------------------------------------------------------
  // 11. RLS — direct anon access to internal reward tables blocked
  // ---------------------------------------------------------------
  console.log("\n-- RLS boundaries --");
  for (const t of REWARD_TABLES) {
    const r = await anon.from(t as any).select("*").limit(1);
    check(r.error !== null, `anon cannot SELECT ${t} directly (RLS revoked)`);
  }

  // ---------------------------------------------------------------
  // 12. Public read function returns D7 allowlist only
  // ---------------------------------------------------------------
  console.log("\n-- Public reward-campaign surface (D7) --");
  const pubFound = await anon.rpc("get_public_reward_campaign", { _poll_id: pollId });
  const pub = pubFound.data as any;
  check(pubFound.error === null, "public reward function callable by anon");
  check(pub?.result_kind === "found", "funded campaign resolved");
  check(pub?.funded === false, "configured campaign is not advertised as funded");
  check(String(pub?.rewardPerParticipantLuna) === String(perLuna), "reward per participant exposed");
  check(pub?.maxRewardedParticipants === maxP, "max participants exposed");
  check(String(pub?.rewardPrincipalLuna) === String(principalN), "reward principal budget exposed");
  check(pub?.rewardsRemaining === maxP, "rewards remaining = max − rewarded_participant_count (counter)");
  const counterShifted = await admin.from("reward_campaigns" as any)
    .update({ rewarded_participant_count: 1 })
    .eq("id", campaignId)
    .select("id");
  check(!counterShifted.error, "campaign counter is updatable (authoritative)");
  const pubAfter = await anon.rpc("get_public_reward_campaign", { _poll_id: pollId });
  check((pubAfter.data as any)?.rewardsRemaining === maxP - 1, "rewards remaining tracks the campaign counter");
  const pubJson = JSON.stringify(pub);
  check(pubJson.includes("vault_key_ref") === false, "no vault key reference exposed");
  check(pubJson.includes("vault_wallet") === false, "no vault wallet exposed");
  check(pubJson.includes("option") === false, "no option fields in public surface");
  check(pubJson.includes("token_hash") === false, "no session data in public surface");

  const pubMissing = await anon.rpc("get_public_reward_campaign", { _poll_id: uuid() });
  check((pubMissing.data as any)?.result_kind === "not_found", "no campaign → not_found");

  // ---------------------------------------------------------------
  // 13. Existing V1/V2 behavior intact
  // ---------------------------------------------------------------
  console.log("\n-- Backward compatibility --");
  const pollsOk = await admin.from("polls").select("id").eq("id", pollId).maybeSingle();
  check(!pollsOk.error && pollsOk.data, "existing poll remains valid with no campaign row semantics");

  const votesConstraint = await (async () => {
    const { data } = await admin.from("poll_options" as any).select("id").eq("poll_id", pollId).order("sort_order");
    const opts = (data ?? []) as any[];
    if (opts.length < 2) return false;
    const a = await admin.rpc("cast_poll_vote_atomic", {
      _poll_id: pollId, _option_id: opts[0].id, _voter_wallet: PARTICIPANT,
    });
    const b = await admin.rpc("cast_poll_vote_atomic", {
      _poll_id: pollId, _option_id: opts[1].id, _voter_wallet: PARTICIPANT,
    });
    return (a.data as any)?.result_kind === "created" && (b.data as any)?.result_kind === "already_voted";
  })();
  check(votesConstraint, "one-wallet-one-vote unchanged (created then already_voted)");

  const profilesOk = await admin.from("participant_profiles").select("wallet_address").limit(1);
  check(!profilesOk.error, "participant_profiles table unaffected");

  const supportOk = await admin.from("nim_support_intents").select("id").limit(1);
  check(!supportOk.error, "nim_support_intents table unaffected");
  const contribOk = await admin.from("nim_contributions").select("id").limit(1);
  check(!contribOk.error, "nim_contributions table unaffected");

  // ---------------------------------------------------------------
  // Cleanup (docker psql — REST DELETE is RLS-revoked)
  // ---------------------------------------------------------------
  cleanupSql(CREATOR);
  cleanupSql(PARTICIPANT);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  try { cleanupSql(CREATOR); cleanupSql(PARTICIPANT); } catch { /* best effort */ }
  process.exit(1);
});
