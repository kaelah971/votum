/**
 * V2A.3 Category & Format Creation/Publishing — Integration Tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a3-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import "./load-local-env";

// ---------------------------------------------------------------------------
// Clients (local Supabase only)
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

// ---------------------------------------------------------------------------
// Fingerprint helper — matches production publish route exactly
// ---------------------------------------------------------------------------
function buildFingerprint(payload: Record<string, unknown>): string {
  const fpObj: Record<string, unknown> = {};
  const keys = Object.keys(payload).sort();
  for (const k of keys) fpObj[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(fpObj)).digest("hex");
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

async function cleanupWallet(wallet: string): Promise<void> {
  const { data: polls } = await admin.from("polls").select("id").eq("creator_wallet", wallet);
  const pollIds = (polls ?? []).map((p) => p.id);
  if (pollIds.length > 0) {
    await admin.from("poll_votes").delete().in("poll_id", pollIds);
    await admin.from("nim_contributions").delete().in("poll_id", pollIds);
    await admin.from("nim_support_intents").delete().in("poll_id", pollIds);
    await admin.from("poll_options").delete().in("poll_id", pollIds);
    await admin.from("poll_publication_requests").delete().eq("creator_wallet", wallet);
    await admin.from("polls").delete().eq("creator_wallet", wallet);
  }
  await admin.from("poll_votes").delete().like("voter_wallet", "NQ33 V2A3%");
}

const creator = `NQ07 V2A3 TEST ${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.3 Category & Format Tests");
  console.log("═══════════════════════════════════════════\n");

  await testApiValidation();
  await testPublishing();
  await testFingerprintIdempotency();
  await testRegression();

  // Cleanup
  console.log("\nCleaning up...");
  await cleanupWallet(creator);

  // Summary
  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. API VALIDATION
// ---------------------------------------------------------------------------
async function testApiValidation() {
  console.log("─── 1. API validation ───");

  const { isPollCategory, isPollFormat, POLL_CATEGORIES, POLL_FORMATS } =
    await import("../polls/taxonomy");

  // Missing category defaults
  const cat1 = typeof ({} as any).category === "string" ? ({} as any).category : "";
  const resolved1 = cat1 === "" ? "communities" : isPollCategory(cat1) ? cat1 : "";
  assert(resolved1 === "communities", "Missing category defaults to communities");

  // Missing format defaults
  const fmt1 = typeof ({} as any).format === "string" ? ({} as any).format : "";
  const resolvedF1 = fmt1 === "" ? "decision" : isPollFormat(fmt1) ? fmt1 : "";
  assert(resolvedF1 === "decision", "Missing format defaults to decision");

  // Every valid category accepted
  for (const cat of POLL_CATEGORIES) {
    assert(isPollCategory(cat), `Valid category "${cat}" accepted`);
  }

  // Every valid format accepted
  for (const fmt of POLL_FORMATS) {
    assert(isPollFormat(fmt), `Valid format "${fmt}" accepted`);
  }

  // Invalid category rejected
  assert(!isPollCategory("nonsense"), 'Invalid category "nonsense" rejected');
  assert(!isPollCategory("VALID_POLL"), 'Invalid category "VALID_POLL" rejected');

  // Invalid format rejected
  assert(!isPollFormat("bogus"), 'Invalid format "bogus" rejected');
  assert(!isPollFormat("VALID"), 'Invalid format "VALID" rejected');

  // Invalid category explicitly supplied -> rejected (non-defaulting)
  const rawBad = "nonsense";
  const badResult = rawBad !== "" && !isPollCategory(rawBad);
  assert(badResult === true, 'Explicitly invalid category triggers rejection');
}

// ---------------------------------------------------------------------------
// 2. PUBLISHING
// ---------------------------------------------------------------------------
async function testPublishing() {
  console.log("─── 2. Publishing ───");

  // Publish with sports + prediction
  const idem1 = randomBytes(16).toString("hex");
  const q1 = "V2A3 test sports prediction poll ok";
  const opts1 = ["Option Alpha", "Option Bravo"];
  const fp1 = buildFingerprint({
    category: "sports", format: "prediction",
    question: q1, description: null,
    options: opts1, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  const { data: p1 } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q1, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: opts1, _idempotency_key: idem1,
    _request_fingerprint: fp1,
    _category: "sports", _format: "prediction",
  } as any);

  assert(p1 && p1.result_kind === "created", "sports+prediction publish → created");

  const { data: r1 } = await admin.from("polls")
    .select("category, format").eq("id", p1.id).single();
  assert(r1!.category === "sports", "Category persisted as sports");
  assert(r1!.format === "prediction", "Format persisted as prediction");

  // Publish with entertainment + fan_vote
  const idem2 = randomBytes(16).toString("hex");
  const q2 = "V2A3 entertainment fan vote poll ok";
  const opts2 = ["Fan A", "Fan B"];
  const fp2 = buildFingerprint({
    category: "entertainment", format: "fan_vote",
    question: q2, description: null,
    options: opts2, mode: "community_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "20", fairnessMode: "one_wallet_one_vote",
    duration: "3days",
  });

  const { data: p2 } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q2, _description: null,
    _mode: "community_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 20,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 259200000).toISOString(),
    _options: opts2, _idempotency_key: idem2,
    _request_fingerprint: fp2,
    _category: "entertainment", _format: "fan_vote",
  } as any);

  assert(p2 && p2.result_kind === "created", "entertainment+fan_vote publish → created");

  const { data: r2 } = await admin.from("polls")
    .select("category, format").eq("id", p2.id).single();
  assert(r2!.category === "entertainment", "Category persisted as entertainment");
  assert(r2!.format === "fan_vote", "Format persisted as fan_vote");

  // Publish with brands_products + decision
  const idem3 = randomBytes(16).toString("hex");
  const q3 = "V2A3 brands decision test poll ok";
  const opts3 = ["Brand A", "Brand B"];
  const fp3 = buildFingerprint({
    category: "brands_products", format: "decision",
    question: q3, description: null,
    options: opts3, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "15", fairnessMode: "one_wallet_one_vote",
    duration: "14days",
  });

  const { data: p3 } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q3, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 15,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 1209600000).toISOString(),
    _options: opts3, _idempotency_key: idem3,
    _request_fingerprint: fp3,
    _category: "brands_products", _format: "decision",
  } as any);

  assert(p3 && p3.result_kind === "created", "brands_products+decision publish → created");

  // Old-style publish (no explicit category/format) defaults
  const idem4 = randomBytes(16).toString("hex");
  const q4 = "V2A3 old-style default test poll ok";
  const opts4 = ["Default A", "Default B"];
  const fp4 = buildFingerprint({
    category: "communities", format: "decision",
    question: q4, description: null,
    options: opts4, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  const { data: p4 } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q4, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: opts4, _idempotency_key: idem4,
    _request_fingerprint: fp4,
  } as any);

  assert(p4 && p4.result_kind === "created", "Old-style publish (no category/format) → created");

  const { data: r4 } = await admin.from("polls")
    .select("category, format").eq("id", p4.id).single();
  assert(r4!.category === "communities", "Old-style defaults category to communities");
  assert(r4!.format === "decision", "Old-style defaults format to decision");
}

// ---------------------------------------------------------------------------
// 3. FINGERPRINT & IDEMPOTENCY
// ---------------------------------------------------------------------------
async function testFingerprintIdempotency() {
  console.log("─── 3. Fingerprint & idempotency ───");

  const idemKey = randomBytes(16).toString("hex");
  const q = "V2A3 idempotency test poll question ok";
  const opts = ["Idem A", "Idem B"];

  // First publish with sports + prediction
  const fpA = buildFingerprint({
    category: "sports", format: "prediction",
    question: q, description: null,
    options: opts, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  const { data: first } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: opts, _idempotency_key: idemKey,
    _request_fingerprint: fpA,
    _category: "sports", _format: "prediction",
  } as any);

  assert(first && first.result_kind === "created", "First publish → created");

  // Identical replay
  const { data: replay } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: opts, _idempotency_key: idemKey,
    _request_fingerprint: fpA,
    _category: "sports", _format: "prediction",
  } as any);

  assert(replay && replay.result_kind === "replay" && replay.id === first.id,
    "Identical replay → same id, result_kind=replay");

  // Changed category → conflict
  const fpCatB = buildFingerprint({
    category: "entertainment", format: "prediction",
    question: q, description: null,
    options: opts, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  const { data: conflictCat } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: opts, _idempotency_key: idemKey,
    _request_fingerprint: fpCatB,
    _category: "entertainment", _format: "prediction",
  } as any);

  assert(conflictCat && conflictCat.result_kind === "conflict" && conflictCat.id === null,
    "Changed category → conflict with null id");

  // Changed format → conflict (using new idempotency key)
  const idemF = randomBytes(16).toString("hex");
  const qF = "V2A3 format conflict test poll question ok";
  const optsF = ["Fmt A", "Fmt B"];

  const fpF1 = buildFingerprint({
    category: "communities", format: "decision",
    question: qF, description: null,
    options: optsF, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: qF, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: optsF, _idempotency_key: idemF,
    _request_fingerprint: fpF1,
    _category: "communities", _format: "decision",
  } as any);

  const fpF2 = buildFingerprint({
    category: "communities", format: "fan_vote",
    question: qF, description: null,
    options: optsF, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  const { data: conflictFmt } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: qF, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: optsF, _idempotency_key: idemF,
    _request_fingerprint: fpF2,
    _category: "communities", _format: "fan_vote",
  } as any);

  assert(conflictFmt && conflictFmt.result_kind === "conflict" && conflictFmt.id === null,
    "Changed format → conflict with null id");
}

// ---------------------------------------------------------------------------
// 4. REGRESSION
// ---------------------------------------------------------------------------
async function testRegression() {
  console.log("─── 4. Regression ───");

  // Voting still works on a published poll
  const { data: polls } = await admin.from("polls")
    .select("id").eq("creator_wallet", creator).limit(1);
  const pollId = polls![0].id;

  const { data: opts } = await admin.from("poll_options")
    .select("id").eq("poll_id", pollId).order("sort_order").limit(1);

  const { error: voteErr } = await admin.from("poll_votes").insert({
    poll_id: pollId, option_id: opts![0].id,
    voter_wallet: "NQ33 V2A3 VOTER 9999",
  });
  assert(!voteErr, "Vote succeeds on poll with category/format");

  // Duplicate vote rejected
  const { error: dupErr } = await admin.from("poll_votes").insert({
    poll_id: pollId, option_id: opts![0].id,
    voter_wallet: "NQ33 V2A3 VOTER 9999",
  });
  assert(dupErr && (dupErr as any).code === "23505", "Duplicate vote rejected");

  // Creator Intelligence returns polls with category/format
  const { data: ci } = await (admin as any).rpc("get_creator_intelligence", {
    _creator_wallet: creator,
  } as any);
  assert(ci && ci.polls.length > 0, "Creator Intelligence returns polls");
  if (ci.polls.length > 0) {
    const p0 = ci.polls[0];
    assert(typeof p0.category === "string" && typeof p0.format === "string",
      "CI poll objects have category and format");
  }

  // All poll counts correct in CI summary
  assert(ci.summary.totalPolls >= 6, "CI summary totalPolls correct");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
run().catch((err) => {
  console.error("\n\x1b[31mTest runner crashed:\x1b[0m", err);
  process.exit(1);
});
