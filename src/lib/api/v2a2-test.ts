/**
 * V2A.2 Structured Discovery — Integration Tests
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/lib/api/v2a2-test.ts
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
// Fingerprint helper
// ---------------------------------------------------------------------------
function fp(q: string, o: string[]): string {
  const payload = q + o.join(",");
  return createHash("sha256").update(payload).digest("hex");
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

import { cleanupTestWallet } from "./local-test-cleanup";

// Also clean up any V2A2 test votes that might match the voter wallet
async function cleanupVotes(): Promise<void> {
  await admin.from("poll_votes").delete().like("voter_wallet", "NQ33 V2A2%");
}

const creator = `NQ07 V2A2 TEST ${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.2 Structured Discovery Tests");
  console.log("═══════════════════════════════════════════\n");

  // ── 1. Taxonomy type guards ──────────────────────────────────────
  await testTaxonomyTypeGuards();

  // ── 2. Taxonomy normalization ────────────────────────────────────
  await testTaxonomyNormalization();

  // ── 3. Draft normalization ──────────────────────────────────────
  await testDraftNormalization();

  // ── 4. Public poll data layer ────────────────────────────────────
  await testPublicPollMapping();

  // ── 5. Creator Intelligence ──────────────────────────────────────
  await testCreatorIntelligence();

  // ── 6. Backward compatibility ────────────────────────────────────
  await testBackwardCompat();

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log("\nCleaning up...");
  cleanupTestWallet(creator);
  await cleanupVotes();

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Taxonomy type guards
// ---------------------------------------------------------------------------
async function testTaxonomyTypeGuards() {
  console.log("─── 1. Taxonomy type guards ───");

  const { isPollCategory, isPollFormat, POLL_CATEGORIES, POLL_FORMATS } =
    await import("../polls/taxonomy");

  for (const cat of POLL_CATEGORIES) {
    assert(isPollCategory(cat), `isPollCategory("${cat}") → true`);
  }

  for (const fmt of POLL_FORMATS) {
    assert(isPollFormat(fmt), `isPollFormat("${fmt}") → true`);
  }

  assert(!isPollCategory(null), "isPollCategory(null) → false");
  assert(!isPollCategory(undefined), "isPollCategory(undefined) → false");
  assert(!isPollCategory(5), "isPollCategory(5) → false");
  assert(!isPollCategory("nonsense"), 'isPollCategory("nonsense") → false');
  assert(!isPollCategory(""), 'isPollCategory("") → false');

  assert(!isPollFormat(null), "isPollFormat(null) → false");
  assert(!isPollFormat(undefined), "isPollFormat(undefined) → false");
  assert(!isPollFormat({}), "isPollFormat({}) → false");
  assert(!isPollFormat("bogus"), 'isPollFormat("bogus") → false');
  assert(!isPollFormat(""), 'isPollFormat("") → false');
}

// ---------------------------------------------------------------------------
// 2. Taxonomy normalization
// ---------------------------------------------------------------------------
async function testTaxonomyNormalization() {
  console.log("─── 2. Taxonomy normalization ───");

  const { normalizeCategory, normalizeFormat } =
    await import("../polls/taxonomy");

  assert(normalizeCategory("sports") === "sports", "normalizeCategory(sports) → sports");
  assert(normalizeCategory("other") === "other", "normalizeCategory(other) → other");
  assert(normalizeCategory("bogus") === "communities", "normalizeCategory(bogus) → communities");
  assert(normalizeCategory(null) === "communities", "normalizeCategory(null) → communities");
  assert(normalizeCategory(undefined) === "communities", "normalizeCategory(undefined) → communities");
  assert(normalizeCategory("") === "communities", 'normalizeCategory("") → communities');

  assert(normalizeFormat("prediction") === "prediction", "normalizeFormat(prediction) → prediction");
  assert(normalizeFormat("audience_choice") === "audience_choice", "normalizeFormat(audience_choice) → audience_choice");
  assert(normalizeFormat("garbage") === "decision", "normalizeFormat(garbage) → decision");
  assert(normalizeFormat(42) === "decision", "normalizeFormat(42) → decision");
  assert(normalizeFormat(undefined) === "decision", "normalizeFormat(undefined) → decision");
}

// ---------------------------------------------------------------------------
// 3. Draft normalization (unit test, no browser)
// ---------------------------------------------------------------------------
async function testDraftNormalization() {
  console.log("─── 3. Draft normalization ───");

  // Test the normalization logic directly (same as in storage.ts readAll)
  const { normalizeCategory, normalizeFormat } = await import("../polls/taxonomy");

  function normalizeDraft(draft: Record<string, unknown>): { category: PollCategory; format: PollFormat } {
    return {
      category: normalizeCategory(draft.category),
      format: normalizeFormat(draft.format),
    };
  }

  // Old draft missing both fields
  let r = normalizeDraft({ id: "x", question: "old draft" });
  assert(r.category === "communities" && r.format === "decision",
    "Old draft (missing both) → communities + decision");

  // Draft with valid values
  r = normalizeDraft({ category: "sports", format: "prediction" });
  assert(r.category === "sports" && r.format === "prediction",
    "Draft with valid values → sports + prediction");

  // Draft with invalid values
  r = normalizeDraft({ category: "INVALID", format: "BOGUS" });
  assert(r.category === "communities" && r.format === "decision",
    "Draft with invalid values → defaults");

  // Draft with only one field
  r = normalizeDraft({ category: "entertainment", format: undefined });
  assert(r.category === "entertainment" && r.format === "decision",
    "Draft with valid category, missing format");

  // Current draft values survive
  r = normalizeDraft({ category: "brands_products", format: "ranking" });
  assert(r.category === "brands_products" && r.format === "ranking",
    "Current draft values survive serialization");
}

// ---------------------------------------------------------------------------
// 4. Public poll mapping
// ---------------------------------------------------------------------------
async function testPublicPollMapping() {
  console.log("─── 4. Public poll mapping ───");

  const idemKey = randomBytes(16).toString("hex");
  const q = "V2A2 test poll for public mapping ok";
  const opts = ["Alpha Public", "Bravo Public"];

  const { data: pub } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator,
    _question: q,
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creator,
    _destination_purpose: "test",
    _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: opts,
    _idempotency_key: idemKey,
    _request_fingerprint: fp(q, opts),
    _category: "entertainment",
    _format: "fan_vote",
  } as any);

  assert(pub && pub.result_kind === "created", "Publish poll for mapping test");

  const pollId = pub.id;

  // Fetch via listPublicPolls-like query
  const { data: rows } = await admin
    .from("polls")
    .select("category, format")
    .eq("id", pollId)
    .single();

  assert(Boolean(rows), "Poll exists in database");
  assert(rows!.category === "entertainment", "category = entertainment");
  assert(rows!.format === "fan_vote", "format = fan_vote");
}

// ---------------------------------------------------------------------------
// 5. Creator Intelligence
// ---------------------------------------------------------------------------
async function testCreatorIntelligence() {
  console.log("─── 5. Creator Intelligence ───");

  // Publish a poll with specific category/format
  const idemKey = randomBytes(16).toString("hex");
  const q = "V2A2 CI test poll question here ok";
  const opts = ["CI Alpha", "CI Bravo"];

  await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator,
    _question: q,
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creator,
    _destination_purpose: "test",
    _min_nim_luna: 15,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: opts,
    _idempotency_key: idemKey,
    _request_fingerprint: fp(q, opts),
    _category: "sports",
    _format: "prediction",
  } as any);

  const { data } = await (admin as any).rpc("get_creator_intelligence", {
    _creator_wallet: creator,
  } as any);

  assert(Boolean(data), "get_creator_intelligence returned data");
  assert(typeof data.summary === "object", "summary is an object");
  assert(Array.isArray(data.polls), "polls is an array");
  assert(data.polls.length >= 1, "At least 1 poll returned");

  const poll = data.polls[0];
  assert(typeof poll.category === "string", "Poll has category (string)");
  assert(typeof poll.format === "string", "Poll has format (string)");

  // Activity objects should NOT have category/format (unchanged)
  if (data.activity && data.activity.length > 0) {
    const act = data.activity[0];
    assert(
      !("category" in act) && !("format" in act),
      "Activity objects do not have category/format"
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Backward compatibility
// ---------------------------------------------------------------------------
async function testBackwardCompat() {
  console.log("─── 6. Backward compatibility ───");

  // Old-style publish (no category/format) → defaults
  const idemKey = randomBytes(16).toString("hex");
  const q = "V2A2 backward compat test question";
  const opts = ["Compat Alpha", "Compat Bravo"];

  const { data: pub } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator,
    _question: q,
    _description: null,
    _mode: "community_support",
    _destination_wallet: creator,
    _destination_purpose: "test",
    _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: opts,
    _idempotency_key: idemKey,
    _request_fingerprint: fp(q, opts),
  } as any);

  assert(pub && pub.result_kind === "created", "Old-style publish succeeds");

  const { data: row } = await admin
    .from("polls")
    .select("category, format")
    .eq("id", pub.id)
    .single();

  assert(
    row!.category === "communities" && row!.format === "decision",
    "Old-style publish defaults to communities + decision"
  );

  // Voting still works (via direct insert as tested in V2A.1)
  const { data: compatOpts } = await admin
    .from("poll_options")
    .select("id")
    .eq("poll_id", pub.id)
    .order("sort_order", { ascending: true })
    .limit(1);

  const { error: voteErr } = await admin.from("poll_votes").insert({
    poll_id: pub.id,
    option_id: (compatOpts![0] as any).id,
    voter_wallet: "NQ33 V2A2 COMPAT VOTER",
  });

  assert(!voteErr, "Vote succeeds on poll created with defaults");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
run().catch((err) => {
  console.error("\n\x1b[31mTest runner crashed:\x1b[0m", err);
  process.exit(1);
});
