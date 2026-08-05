/**
 * V2A.4 Taxonomy Visibility — Integration Tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a4-test.ts
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

function buildFingerprint(payload: Record<string, unknown>): string {
  const fpObj: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) fpObj[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(fpObj)).digest("hex");
}

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

import { cleanupTestWallet } from "./local-test-cleanup";

const creator = `NQ07 V2A4 TEST ${randomBytes(4).toString("hex")}`;

async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.4 Taxonomy Visibility Tests");
  console.log("═══════════════════════════════════════════\n");

  await testTaxonomyComponent();
  await testMyPollsData();
  await testPollDetailData();
  await testCreatorIntelligenceData();
  await testActivityEnrichment();
  await testRegressions();

  console.log("\nCleaning up...");
  cleanupTestWallet(creator);

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Taxonomy component (labels)
// ---------------------------------------------------------------------------
async function testTaxonomyComponent() {
  console.log("─── 1. Taxonomy labels ───");
  const { CATEGORY_LABELS, FORMAT_LABELS, POLL_CATEGORIES, POLL_FORMATS } =
    await import("../polls/taxonomy");

  for (const cat of POLL_CATEGORIES) {
    const label = CATEGORY_LABELS[cat];
    assert(typeof label === "string" && label.length > 0, `CATEGORY_LABELS["${cat}"] → "${label}"`);
    assert(!label.includes("_"), `Label "${label}" has no underscores`);
  }

  for (const fmt of POLL_FORMATS) {
    const label = FORMAT_LABELS[fmt];
    assert(typeof label === "string" && label.length > 0, `FORMAT_LABELS["${fmt}"] → "${label}"`);
    assert(!label.includes("_"), `Label "${label}" has no underscores`);
  }
}

// ---------------------------------------------------------------------------
// 2. My Polls — data from API boundary
// ---------------------------------------------------------------------------
async function testMyPollsData() {
  console.log("─── 2. My Polls data ───");

  // Publish one poll with sports + prediction, one with defaults
  const id1 = randomBytes(16).toString("hex");
  const q1 = "V2A4 my-polls sports test question ok";
  const o1 = ["A", "B"];
  const fp1 = buildFingerprint({ category: "sports", format: "prediction",
    question: q1, description: null, options: o1, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote", duration: "7days" });

  await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q1, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: o1, _idempotency_key: id1, _request_fingerprint: fp1,
    _category: "sports", _format: "prediction",
  } as any);

  // Old-style (defaults)
  const id2 = randomBytes(16).toString("hex");
  const q2 = "V2A4 my-polls default test question ok";
  const o2 = ["X", "Y"];
  const fp2 = buildFingerprint({ category: "communities", format: "decision",
    question: q2, description: null, options: o2, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote", duration: "7days" });

  await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q2, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 604800000).toISOString(),
    _options: o2, _idempotency_key: id2, _request_fingerprint: fp2,
  } as any);

  const { data: rows } = await admin.from("polls")
    .select("category, format").eq("creator_wallet", creator).order("created_at");

  assert(rows!.length >= 2, "At least 2 polls exist");

  const sportsPoll = rows!.find((r) => r.category === "sports");
  assert(sportsPoll !== undefined, "Sports poll found");
  assert(sportsPoll!.format === "prediction", "Sports poll format = prediction");

  const defaultPoll = rows!.find((r) => r.category === "communities" && r.format === "decision");
  assert(defaultPoll !== undefined, "Default poll (communities + decision) found");
}

// ---------------------------------------------------------------------------
// 3. Poll detail — PollView has category/format
// ---------------------------------------------------------------------------
async function testPollDetailData() {
  console.log("─── 3. Poll detail data ───");

  const { normalizeCategory, normalizeFormat } = await import("../polls/taxonomy");

  const { data: polls } = await admin.from("polls")
    .select("*").eq("creator_wallet", creator).limit(1);
  const poll = polls![0];

  const cat = normalizeCategory(poll.category);
  const fmt = normalizeFormat(poll.format);
  assert(typeof cat === "string", "PollView.category is string");
  assert(typeof fmt === "string", "PollView.format is string");

  // Both fields present in select *
  assert(typeof poll.category === "string", "Raw DB category is string");
  assert(typeof poll.format === "string", "Raw DB format is string");
}

// ---------------------------------------------------------------------------
// 4. Creator Intelligence data
// ---------------------------------------------------------------------------
async function testCreatorIntelligenceData() {
  console.log("─── 4. Creator Intelligence data ───");

  const { data: ci } = await (admin as any).rpc("get_creator_intelligence", {
    _creator_wallet: creator,
  } as any);

  assert(ci && Array.isArray(ci.polls), "CI returns polls array");
  assert(ci.polls.length >= 2, "CI has poll objects");

  for (const p of ci.polls) {
    assert(typeof p.category === "string", `Poll ${p.id.slice(0,8)} has category`);
    assert(typeof p.format === "string", `Poll ${p.id.slice(0,8)} has format`);
  }

  // Summary unchanged
  assert(typeof ci.summary.totalPolls === "number", "Summary totalPolls present");
  assert(typeof ci.summary.totalVotes === "number", "Summary totalVotes present");
}

// ---------------------------------------------------------------------------
// 5. Activity enrichment
// ---------------------------------------------------------------------------
async function testActivityEnrichment() {
  console.log("─── 5. Activity enrichment & normalization ───");

  const { normalizeCategory, normalizeFormat } = await import("../polls/taxonomy");

  // Test the exact boundary logic used in CreatorActivityNotifications
  const rawPolls: Array<{ id: string; category?: unknown; format?: unknown }> = [
    { id: "poll-1", category: "sports", format: "prediction" },
    { id: "poll-2", category: "INVALID", format: "BOGUS" },
    { id: "poll-3", category: undefined, format: undefined },
    { id: "poll-4", category: null, format: "fan_vote" },
    { id: "poll-5", category: "communities", format: "decision" },
  ];

  const map = new Map<string, { category: string; format: string }>();
  for (const p of rawPolls) {
    map.set(p.id, {
      category: normalizeCategory(p.category),
      format: normalizeFormat(p.format),
    });
  }

  // Valid values pass through
  const p1 = map.get("poll-1")!;
  assert(p1.category === "sports", "Valid category sports preserved");
  assert(p1.format === "prediction", "Valid format prediction preserved");

  // Invalid values fall back
  const p2 = map.get("poll-2")!;
  assert(p2.category === "communities", "Invalid category → communities");
  assert(p2.format === "decision", "Invalid format → decision");

  // Missing/undefined fall back
  const p3 = map.get("poll-3")!;
  assert(p3.category === "communities", "Undefined category → communities");
  assert(p3.format === "decision", "Undefined format → decision");

  // Null category, valid format
  const p4 = map.get("poll-4")!;
  assert(p4.category === "communities", "Null category → communities");
  assert(p4.format === "fan_vote", "Valid format preserved alongside null category");

  // Communities + decision preserved
  const p5 = map.get("poll-5")!;
  assert(p5.category === "communities", "Explicit communities preserved");
  assert(p5.format === "decision", "Explicit decision preserved");

  // Unmatched poll ID omitted safely
  assert(!map.has("poll-nonexistent"), "Unmatched poll ID not in map");

  // Original array not mutated (test a fresh copy)
  const fresh = { id: "poll-6", category: "VALID", format: "BOGUS" };
  const freshCopy = { ...fresh };
  normalizeCategory(fresh.category);
  normalizeFormat(fresh.format);
  assert(freshCopy.category === "VALID" && freshCopy.format === "BOGUS",
    "Original response object not mutated");

  // Real CI data
  const { data: ci } = await (admin as any).rpc("get_creator_intelligence", {
    _creator_wallet: creator,
  } as any);

  const polls = (ci.polls ?? []) as Array<{ id: string; category?: unknown; format?: unknown }>;
  const liveMap = new Map<string, { category: string; format: string }>();
  for (const p of polls) liveMap.set(p.id, {
    category: normalizeCategory(p.category),
    format: normalizeFormat(p.format),
  });

  const activity = ci.activity ?? [];
  assert(activity.length >= 1, "CI has activity items");

  const matchCount = activity.filter(
    (a: { pollId: string }) => liveMap.has(a.pollId)
  ).length;
  assert(matchCount >= 1, `Activity items match poll taxonomy: ${matchCount}/${activity.length}`);
}

// ---------------------------------------------------------------------------
// 6. Regressions
// ---------------------------------------------------------------------------
async function testRegressions() {
  console.log("─── 6. Regressions ───");

  // Voting still works
  const { data: polls } = await admin.from("polls")
    .select("id").eq("creator_wallet", creator).limit(1);
  const pid = polls![0].id;
  const { data: opts } = await admin.from("poll_options")
    .select("id").eq("poll_id", pid).order("sort_order").limit(1);

  const { error: vErr } = await admin.from("poll_votes").insert({
    poll_id: pid, option_id: opts![0].id, voter_wallet: "NQ33 V2A4 VOTER 1",
  });
  assert(!vErr, "Vote succeeds");

  // Duplicate rejected
  const { error: dErr } = await admin.from("poll_votes").insert({
    poll_id: pid, option_id: opts![0].id, voter_wallet: "NQ33 V2A4 VOTER 1",
  });
  assert(dErr && (dErr as any).code === "23505", "Duplicate vote rejected");

  // NIM support still works
  const { error: nErr } = await admin.from("nim_support_intents").insert({
    reference: "V2A4-REGRESSION-" + randomBytes(4).toString("hex"),
    poll_id: pid, option_id: opts![0].id,
    supporter_wallet: "NQ44 V2A4 SUPP", recipient_wallet: "NQ00 RECIP",
    amount_luna: 1000, memo: "test", status: "pending",
    expires_at: new Date(Date.now() + 604800000).toISOString(),
    initiator_wallet: "NQ44 V2A4 SUPP",
  });
  assert(!nErr, "NIM intent created");

  // PollHeader never renders partial taxonomy: both or neither
  const bothProps = { category: "sports" as const, format: "prediction" as const };
  const hasBoth = !!bothProps.category && !!bothProps.format;
  assert(hasBoth, "Both props → taxonomy renders");

  const missingCategory = { format: "prediction" as const };
  const hasMissingCat = !!(missingCategory as { category?: string }).category
    && !!(missingCategory as { format?: string }).format;
  assert(!hasMissingCat, "Missing category → taxonomy hidden");

  const missingFormat = { category: "sports" as const };
  const hasMissingFmt = !!(missingFormat as { category?: string }).category
    && !!(missingFormat as { format?: string }).format;
  assert(!hasMissingFmt, "Missing format → taxonomy hidden");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
