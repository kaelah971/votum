/**
 * V2A.5 Structured Explore — Integration Tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a5-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { PollView } from "@/types/poll";

import "./load-local-env";

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

const creator = `NQ07 V2A5 TEST ${randomBytes(4).toString("hex")}`;

function makePollView(overrides: Partial<PollView> = {}): PollView {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    question: "Test question long enough",
    contributionMode: "creator",
    destinationWallet: "NQ00 TEST",
    destinationPurpose: "test",
    minimumNim: 1,
    fairnessMode: "one_wallet_one_vote",
    category: "communities",
    format: "decision",
    createdAt: new Date().toISOString(),
    closingAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    status: "live",
    options: [{ id: "1", label: "A" }],
    ...overrides,
  };
}

async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.5 Structured Explore Tests");
  console.log("═══════════════════════════════════════════\n");

  await testCategoryFiltering();
  await testFormatFiltering();
  await testCombinedFiltering();
  await testSearchFiltering();
  await testSectionClassification();
  await testEffectiveStatusFiltering();
  await testSectionSorting();
  await testDateParser();
  await testPollCardDisplay();
  await testSortModes();
  await testEmptyStates();
  await testPublishingAndRegression();

  console.log("\nCleaning up...");
  cleanupTestWallet(creator);

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Category filtering
// ---------------------------------------------------------------------------
async function testCategoryFiltering() {
  console.log("─── 1. Category filtering ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ category: "sports", format: "prediction" }),
    makePollView({ category: "entertainment", format: "fan_vote" }),
    makePollView({ category: "communities", format: "decision" }),
    makePollView({ category: "sports", format: "ranking" }),
  ];

  const g = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "all", nowMs: now });
  assert(g.closingSoon.length + g.liveNow.length + g.recentlyClosed.length === 4, "All returns all 4");

  const gS = filterAndGroupPolls(polls, { search: "", category: "sports", format: "all", statusFilter: "all", nowMs: now });
  const totalS = gS.closingSoon.length + gS.liveNow.length + gS.recentlyClosed.length;
  assert(totalS === 2, "Sports returns 2");

  const gE = filterAndGroupPolls(polls, { search: "", category: "entertainment", format: "all", statusFilter: "all", nowMs: now });
  const totalE = gE.closingSoon.length + gE.liveNow.length + gE.recentlyClosed.length;
  assert(totalE === 1, "Entertainment returns 1");

  const gC = filterAndGroupPolls(polls, { search: "", category: "communities", format: "all", statusFilter: "all", nowMs: now });
  const totalC = gC.closingSoon.length + gC.liveNow.length + gC.recentlyClosed.length;
  assert(totalC === 1, "Communities returns 1");

  const gO = filterAndGroupPolls(polls, { search: "", category: "other", format: "all", statusFilter: "all", nowMs: now });
  assert(gO.closingSoon.length + gO.liveNow.length + gO.recentlyClosed.length === 0, "Other returns 0");
}

// ---------------------------------------------------------------------------
// 2. Format filtering
// ---------------------------------------------------------------------------
async function testFormatFiltering() {
  console.log("─── 2. Format filtering ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ category: "sports", format: "prediction" }),
    makePollView({ category: "entertainment", format: "fan_vote" }),
    makePollView({ category: "communities", format: "decision" }),
    makePollView({ category: "sports", format: "ranking" }),
    makePollView({ category: "other", format: "prediction" }),
  ];

  const g = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "all", nowMs: now });
  assert(g.closingSoon.length + g.liveNow.length + g.recentlyClosed.length === 5, "All formats returns 5");

  const gP = filterAndGroupPolls(polls, { search: "", category: "all", format: "prediction", statusFilter: "all", nowMs: now });
  const tP = gP.closingSoon.length + gP.liveNow.length + gP.recentlyClosed.length;
  assert(tP === 2, "Prediction returns 2");

  const gD = filterAndGroupPolls(polls, { search: "", category: "all", format: "decision", statusFilter: "all", nowMs: now });
  const tD = gD.closingSoon.length + gD.liveNow.length + gD.recentlyClosed.length;
  assert(tD === 1, "Decision returns 1");

  const gF = filterAndGroupPolls(polls, { search: "", category: "all", format: "fan_vote", statusFilter: "all", nowMs: now });
  const tF = gF.closingSoon.length + gF.liveNow.length + gF.recentlyClosed.length;
  assert(tF === 1, "Fan vote returns 1");
}

// ---------------------------------------------------------------------------
// 3. Combined category + format
// ---------------------------------------------------------------------------
async function testCombinedFiltering() {
  console.log("─── 3. Combined category + format ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ category: "sports", format: "prediction" }),
    makePollView({ category: "sports", format: "ranking" }),
    makePollView({ category: "entertainment", format: "prediction" }),
  ];

  const g1 = filterAndGroupPolls(polls, { search: "", category: "sports", format: "prediction", statusFilter: "all", nowMs: now });
  const t1 = g1.closingSoon.length + g1.liveNow.length + g1.recentlyClosed.length;
  assert(t1 === 1, "Sports + Prediction = 1");

  const g2 = filterAndGroupPolls(polls, { search: "", category: "sports", format: "ranking", statusFilter: "all", nowMs: now });
  const t2 = g2.closingSoon.length + g2.liveNow.length + g2.recentlyClosed.length;
  assert(t2 === 1, "Sports + Ranking = 1");

  const g3 = filterAndGroupPolls(polls, { search: "", category: "entertainment", format: "prediction", statusFilter: "all", nowMs: now });
  const t3 = g3.closingSoon.length + g3.liveNow.length + g3.recentlyClosed.length;
  assert(t3 === 1, "Entertainment + Prediction = 1");
}

// ---------------------------------------------------------------------------
// 4. Search composes with filters
// ---------------------------------------------------------------------------
async function testSearchFiltering() {
  console.log("─── 4. Search ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ question: "Who will win the match?", category: "sports" }),
    makePollView({ question: "Best new product feature?", category: "brands_products" }),
    makePollView({ question: "Who is the top performer?", category: "entertainment" }),
  ];

  const g1 = filterAndGroupPolls(polls, { search: "win", category: "all", format: "all", statusFilter: "all", nowMs: now });
  const t1 = g1.closingSoon.length + g1.liveNow.length + g1.recentlyClosed.length;
  assert(t1 === 1, "Search 'win' finds 1");

  const g2 = filterAndGroupPolls(polls, { search: "product", category: "brands_products", format: "all", statusFilter: "all", nowMs: now });
  const t2 = g2.closingSoon.length + g2.liveNow.length + g2.recentlyClosed.length;
  assert(t2 === 1, "Search 'product' + Brands = 1");

  const g3 = filterAndGroupPolls(polls, { search: "performer", category: "all", format: "all", statusFilter: "all", nowMs: now });
  const t3 = g3.closingSoon.length + g3.liveNow.length + g3.recentlyClosed.length;
  assert(t3 === 1, "Search 'performer' finds 1");
}

// ---------------------------------------------------------------------------
// 5. Section classification & effective status
// ---------------------------------------------------------------------------
async function testSectionClassification() {
  console.log("─── 5. Section classification & effective status ───");
  const { classifyPollSection, effectiveStatus: effStatus } = await import("../explore/filters");
  const now = Date.now();

  // Closing soon: ends within 72 hours
  const p1h = makePollView({ status: "live", closingAt: new Date(now + 3600000).toISOString() });
  assert(effStatus(p1h, now) === "live", "1h from now: effective status = live");
  assert(classifyPollSection(p1h, now) === "closing_soon", "1h from now = closing soon");

  // Ended exactly at now → recently closed
  const pNow = makePollView({ status: "live", closingAt: new Date(now).toISOString() });
  assert(effStatus(pNow, now) === "closed", "exactly now: effective status = closed");
  assert(classifyPollSection(pNow, now) === "recently_closed", "exactly now = recently closed");

  // Ended 1 second ago → recently closed
  const pPast = makePollView({ status: "live", closingAt: new Date(now - 1000).toISOString() });
  assert(effStatus(pPast, now) === "closed", "1s before now: effective status = closed");
  assert(classifyPollSection(pPast, now) === "recently_closed", "1s before now = recently closed");

  // Exactly at 72h boundary → closing soon
  const p72h = makePollView({ status: "live", closingAt: new Date(now + 72 * 3600000).toISOString() });
  assert(effStatus(p72h, now) === "live", "72h from now: effective status = live");
  assert(classifyPollSection(p72h, now) === "closing_soon", "72h from now = closing soon");

  // After 72h → live now
  const p73h = makePollView({ status: "live", closingAt: new Date(now + 73 * 3600000).toISOString() });
  assert(effStatus(p73h, now) === "live", "73h from now: effective status = live");
  assert(classifyPollSection(p73h, now) === "live_now", "73h from now = live now");

  // Stored closed → recently closed
  const pClosed = makePollView({ status: "closed" });
  assert(effStatus(pClosed, now) === "closed", "stored closed: effective status = closed");
  assert(classifyPollSection(pClosed, now) === "recently_closed", "stored closed = recently closed");

  // Missing/invalid deadline → live now
  const pNoEnd = makePollView({ status: "live", closingAt: "" });
  assert(effStatus(pNoEnd, now) === "live", "missing endsAt: effective status = live");
  assert(classifyPollSection(pNoEnd, now) === "live_now", "missing endsAt = live now");

  const pBadEnd = makePollView({ status: "live", closingAt: "not-a-date" });
  assert(effStatus(pBadEnd, now) === "live", "invalid endsAt: effective status = live");
  assert(classifyPollSection(pBadEnd, now) === "live_now", "invalid endsAt = live now");
}

// ---------------------------------------------------------------------------
// 6. Effective-status filtering
// ---------------------------------------------------------------------------
async function testEffectiveStatusFiltering() {
  console.log("─── 6. Effective-status filtering ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ question: "Ended 1h ago", status: "live", closingAt: new Date(now - 3600000).toISOString() }),
    makePollView({ question: "Stored closed", status: "closed", closingAt: new Date(now - 7200000).toISOString() }),
    makePollView({ question: "Alive in 1h", status: "live", closingAt: new Date(now + 3600000).toISOString() }),
    makePollView({ question: "Alive in 100h", status: "live", closingAt: new Date(now + 100 * 3600000).toISOString() }),
  ];

  // Live filter excludes expired live polls
  const gLive = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "live", nowMs: now });
  const totalLive = gLive.closingSoon.length + gLive.liveNow.length;
  assert(totalLive === 2, "Live filter = 2 (excludes stored-closed + expired-live)");
  assert(gLive.recentlyClosed.length === 0, "Live filter has no recently closed");

  // Closed filter includes expired live polls + stored closed
  const gClosed = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "closed", nowMs: now });
  const totalClosed = gClosed.recentlyClosed.length;
  assert(totalClosed === 2, "Closed filter = 2 (stored-closed + expired-live)");

  // All returns all 4, no duplication
  const gAll = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "all", nowMs: now });
  const totalAll = gAll.closingSoon.length + gAll.liveNow.length + gAll.recentlyClosed.length;
  assert(totalAll === 4, "All filter = 4");

  // Expired live is in recently closed, not closing soon
  assert(gAll.recentlyClosed.some((p) => p.question === "Ended 1h ago"), "Expired-live in recently closed");
  assert(!gAll.closingSoon.some((p) => p.question === "Ended 1h ago"), "Expired-live NOT in closing soon");

  // No poll in multiple sections
  const allIds = [...gAll.closingSoon, ...gAll.liveNow, ...gAll.recentlyClosed].map((p) => p.id);
  assert(new Set(allIds).size === allIds.length, "No duplicate poll IDs across sections");

  // Original poll objects not mutated (check effectiveStatus is not on original)
  const orig = polls[0];
  assert(!("effectiveStatus" in orig), "Original poll not mutated (no effectiveStatus key)");
}

// ---------------------------------------------------------------------------
// 7. Section sorting
// ---------------------------------------------------------------------------
async function testSectionSorting() {
  console.log("─── 7. Section sorting ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ id: "poll-c", question: "Latest live", status: "live", createdAt: new Date(now - 1000).toISOString(), closingAt: new Date(now + 8 * 86400000).toISOString() }),
    makePollView({ id: "poll-d", question: "Old live", status: "live", createdAt: new Date(now - 86400000).toISOString(), closingAt: new Date(now + 8 * 86400000).toISOString() }),
    makePollView({ id: "poll-b", question: "Soon 2h", status: "live", createdAt: new Date(now - 2000).toISOString(), closingAt: new Date(now + 2 * 3600000).toISOString() }),
    makePollView({ id: "poll-a", question: "Soon 1h", status: "live", createdAt: new Date(now - 3000).toISOString(), closingAt: new Date(now + 1 * 3600000).toISOString() }),
    makePollView({ id: "poll-z", question: "Invalid deadline", status: "live", createdAt: new Date(now - 86400000 * 2).toISOString(), closingAt: "not-a-date" }),
    makePollView({ id: "poll-y", question: "No deadline", status: "live", createdAt: new Date(now - 86400000 * 2).toISOString(), closingAt: "" }),
  ];

  const g = filterAndGroupPolls(polls, { search: "", category: "all", format: "all", statusFilter: "all", nowMs: now });

  // Closing soon sorted earliest first
  assert(g.closingSoon.length === 2, "2 closing soon");
  assert(g.closingSoon[0].question === "Soon 1h", "Closing soon: earliest first (1h)");
  assert(g.closingSoon[1].question === "Soon 2h", "Closing soon: earliest first (2h)");

  // Live now sorted newest first
  assert(g.liveNow.length === 4, "4 live now (2 valid + 2 invalid deadlines)");
  assert(g.liveNow[0].question === "Latest live", "Live now: newest first");

  // Invalid deadlines sort after valid ones
  const lastTwo = g.liveNow.slice(-2).map((p) => p.question);
  assert(lastTwo.includes("No deadline") && lastTwo.includes("Invalid deadline"),
    "Invalid deadlines sort after valid polls");

  // Ties resolved by id
  const invalidPolls = g.liveNow.slice(-2);
  assert(invalidPolls[0].id.localeCompare(invalidPolls[1].id) < 0,
    "Invalid-deadline ties resolved by id");
}

// ---------------------------------------------------------------------------
// 8. Date parser
// ---------------------------------------------------------------------------
async function testDateParser() {
  console.log("─── 8. Date parser ───");
  const { effectiveStatus } = await import("../explore/filters");
  const now = Date.now();

  const future = makePollView({ status: "live", closingAt: new Date(now + 3600000).toISOString() });
  assert(effectiveStatus(future, now) === "live", "ISO timestamp: future → live");

  const past = makePollView({ status: "live", closingAt: new Date(now - 1000).toISOString() });
  assert(effectiveStatus(past, now) === "closed", "ISO timestamp: past → closed");

  const empty = makePollView({ status: "live", closingAt: "" });
  assert(effectiveStatus(empty, now) === "live", 'Empty closingAt → live (no crash)');

  const garbage = makePollView({ status: "live", closingAt: "not-a-date" });
  assert(effectiveStatus(garbage, now) === "live", "Garbage closingAt → live (no crash)");

  const spaces = makePollView({ status: "live", closingAt: "   " });
  assert(effectiveStatus(spaces, now) === "live", "Whitespace closingAt → live (no crash)");
}

// ---------------------------------------------------------------------------
// 9. PollCard closing-date display
// ---------------------------------------------------------------------------
async function testPollCardDisplay() {
  console.log("─── 9. PollCard display ───");
  const { parseTimestamp, effectiveStatus } = await import("../explore/filters");
  const now = Date.now();

  assert(parseTimestamp(new Date(now + 86400000).toISOString()) !== null, "Valid ISO → valid timestamp");
  assert(parseTimestamp("") === null, 'Empty "" → null');
  assert(parseTimestamp("   ") === null, 'Whitespace → null');
  assert(parseTimestamp("not-a-date") === null, '"not-a-date" → null');
  assert(parseTimestamp("NaN") === null, '"NaN" → null');

  const expired = makePollView({ status: "live", closingAt: new Date(now - 3600000).toISOString() });
  assert(effectiveStatus(expired, now) === "closed", "Expired live poll → effectiveStatus closed");
}

// ---------------------------------------------------------------------------
// 10. Sort modes
// ---------------------------------------------------------------------------
async function testSortModes() {
  console.log("─── 10. Sort modes ───");
  const { filterAndSortResults } = await import("../explore/filters");
  const now = Date.now();

  const polls = [
    makePollView({ id: "poll-a", question: "Closing 1h", status: "live", createdAt: new Date(now - 1000).toISOString(), closingAt: new Date(now + 3600000).toISOString() }),
    makePollView({ id: "poll-b", question: "Closing 50h", status: "live", createdAt: new Date(now - 2000).toISOString(), closingAt: new Date(now + 50 * 3600000).toISOString() }),
    makePollView({ id: "poll-c", question: "Live 100h", status: "live", createdAt: new Date(now - 86400000).toISOString(), closingAt: new Date(now + 100 * 3600000).toISOString() }),
    makePollView({ id: "poll-d", question: "Closed old", status: "closed", createdAt: new Date(now - 86400000 * 2).toISOString(), closingAt: new Date(now - 86400000).toISOString() }),
  ];

  // Grouped mode
  const gr = filterAndSortResults(polls, { search: "", category: "all", format: "all", statusFilter: "all", sortMode: "grouped", nowMs: now });
  assert(gr.mode === "grouped", "Grouped mode returns grouped");
  if (gr.mode === "grouped") {
    assert(gr.groups.closingSoon.length >= 2, "Grouped: closing soon exists");
    assert(gr.groups.liveNow.length >= 1, "Grouped: live now exists");
    assert(gr.groups.recentlyClosed.length >= 1, "Grouped: recently closed exists");
  }

  // Recently created mode
  const rc = filterAndSortResults(polls, { search: "", category: "all", format: "all", statusFilter: "all", sortMode: "recent", nowMs: now });
  assert(rc.mode === "recent", "Recent mode returns recent");
  if (rc.mode === "recent") {
    assert(rc.polls.length === 4, "Recent: 4 polls");
    // Newest first
    assert(rc.polls[0].id === "poll-a", "Recent: newest createdAt first");
    // Live and closed together
    const allStatuses = new Set(rc.polls.map((p) => p.effectiveStatus));
    assert(allStatuses.has("live") && allStatuses.has("closed"), "Recent: live and closed together");
  }

  // Closing soon mode
  const cs = filterAndSortResults(polls, { search: "", category: "all", format: "all", statusFilter: "all", sortMode: "closing", nowMs: now });
  assert(cs.mode === "closing", "Closing mode returns closing");
  if (cs.mode === "closing") {
    assert(cs.polls.length >= 2, "Closing: has valid future deadline polls");
    // Earliest first
    assert(cs.polls[0].id === "poll-a", "Closing: nearest deadline first");
    // No stored-closed or expired-live
    assert(!cs.polls.some((p) => p.status === "closed"), "Closing: no stored-closed");
    assert(!cs.polls.some((p) => p.effectiveStatus === "closed"), "Closing: no effective-closed");
  }

  // Live filter composes
  const csLive = filterAndSortResults(polls, { search: "", category: "all", format: "all", statusFilter: "live", sortMode: "closing", nowMs: now });
  if (csLive.mode === "closing") {
    assert(csLive.polls.length >= 2, "Closing + Live: valid future live only");
  }

  // Closed filter + Closing mode → 0
  const csClosed = filterAndSortResults(polls, { search: "", category: "all", format: "all", statusFilter: "closed", sortMode: "closing", nowMs: now });
  if (csClosed.mode === "closing") {
    assert(csClosed.polls.length === 0, "Closing + Closed: 0 results");
  }
}

// ---------------------------------------------------------------------------
// 11. Empty states
// ---------------------------------------------------------------------------
async function testEmptyStates() {
  console.log("─── 11. Empty states ───");
  const { filterAndGroupPolls } = await import("../explore/filters");
  const now = Date.now();
  const polls: PollView[] = [];

  const g = filterAndGroupPolls(polls, { search: "nothing", category: "sports", format: "prediction", statusFilter: "all", nowMs: now });
  assert(g.closingSoon.length + g.liveNow.length + g.recentlyClosed.length === 0, "Empty filters = 0 results");
}

// ---------------------------------------------------------------------------
// 12. Publishing + Regression
// ---------------------------------------------------------------------------
async function testPublishingAndRegression() {
  console.log("─── 12. Publishing + Regression ───");

  const idem = randomBytes(16).toString("hex");
  const q = "V2A5 explore regression test question ok";
  const opts = ["Explore A", "Explore B"];
  const fp = buildFingerprint({ category: "sports", format: "prediction",
    question: q, description: null, options: opts, mode: "creator_support",
    destinationWallet: creator, destinationPurpose: "test",
    minimumNimLuna: "10", fairnessMode: "one_wallet_one_vote", duration: "3days" });

  const { data: p } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: creator, _question: q, _description: null,
    _mode: "creator_support", _destination_wallet: creator,
    _destination_purpose: "test", _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 259200000).toISOString(),
    _options: opts, _idempotency_key: idem, _request_fingerprint: fp,
    _category: "sports", _format: "prediction",
  } as any);

  assert(p && p.result_kind === "created", "Publish succeeds");

  const { data: row } = await admin.from("polls").select("category, format, status").eq("id", p.id).single();
  assert(row!.category === "sports", "Category = sports");
  assert(row!.format === "prediction", "Format = prediction");
  assert(row!.status === "live", "Status = live (not draft/cancelled)");

  // Vote works
  const { data: opt } = await admin.from("poll_options").select("id").eq("poll_id", p.id).limit(1);
  const { error: vErr } = await admin.from("poll_votes").insert({
    poll_id: p.id, option_id: opt![0].id, voter_wallet: "NQ33 V2A5 VOTER",
  });
  assert(!vErr, "Vote succeeds");

  // NIM intent works
  const { error: nErr } = await admin.from("nim_support_intents").insert({
    reference: "V2A5-" + randomBytes(4).toString("hex"),
    poll_id: p.id, option_id: opt![0].id,
    supporter_wallet: "NQ44 V2A5", recipient_wallet: "NQ00 V2A5",
    amount_luna: 1000, memo: "test", status: "pending",
    expires_at: new Date(Date.now() + 604800000).toISOString(),
    initiator_wallet: "NQ44 V2A5",
  });
  assert(!nErr, "NIM intent succeeds");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
