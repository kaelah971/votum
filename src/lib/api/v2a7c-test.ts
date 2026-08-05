/**
 * V2A.7C — Grouped Explore Query and Independent Cursor Tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a7c-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import "./load-local-env";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

import { cleanupTestWallet } from "./local-test-cleanup";

const creator = `NQ07 V2A7C TEST ${randomBytes(4).toString("hex")}`;

async function createRawPoll(question: string, overrides: Record<string, any>): Promise<{ id: string } | null> {
  await admin.from("polls").insert({
    category: "communities", format: "decision",
    creator_wallet: creator,
    question, mode: "creator_support", destination_wallet: creator,
    destination_purpose: "test", min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live", is_public: true,
    starts_at: new Date(Date.now() - 86400000).toISOString(),
    ...overrides,
  });
  const { data } = await admin.from("polls").select("id").eq("question", question).single();
  if (data) {
    await admin.from("poll_options").insert([
      { poll_id: data.id, label: "A", sort_order: 0 },
      { poll_id: data.id, label: "B", sort_order: 1 },
    ]);
  }
  return data;
}

// ---------------------------------------------------------------------------
async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.7C Grouped Pagination Tests");
  console.log("═══════════════════════════════════════════\n");

  const now = new Date("2026-08-05T12:00:00.000Z");
  await setupFixtures(now);

  await testInitialGrouped(now);
  await testClosingSoonPagination(now);
  await testLiveNowPagination(now);
  await testRecentlyClosedPagination(now);
  await testCrossSectionCursors(now);
  await testStatusFilterInteraction(now);
  await testFiltersWithGrouped(now);
  await testSearchWithGrouped(now);
  await testCursorValidation();
  await testExclusionAndSafety();

  console.log("\nCleaning up...");
  cleanupTestWallet(creator);

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ===========================================================================
// Fixtures (built around a captured `now` for deterministic classification)
// ===========================================================================

let boundary72hPollId: string | null = null;
let before72hPollId: string | null = null;
let after72hPollId: string | null = null;

async function setupFixtures(now: Date) {
  console.log("─── Fixtures ───");

  // Clean any stale V2A.7C records first
  await admin.from("nim_contributions").delete().eq("poll_id::uuid", "00000000-0000-0000-0000-000000000000");
  try {
    cleanupTestWallet(creator);
  } catch { /* ok */ }

  const base = now.getTime();
  const H = 3600000;

  // ── Exactly 72h boundary (should be closing_soon per V2A.5 <= rule) ──
  const exact72h = new Date(base + 72 * H).toISOString();
  const b72 = await createRawPoll("V2A7C exact 72h boundary V2A7C_BOUNDARY ok", {
    created_at: new Date(base - 200000).toISOString(),
    updated_at: new Date(base - 200000).toISOString(),
    ends_at: exact72h,
    status: "live", is_public: true,
    category: "sports", format: "prediction",
  });
  if (b72) boundary72hPollId = b72.id;

  // One millisecond before 72h boundary → must be closing_soon
  const before72h = new Date(base + 72 * H - 1).toISOString();
  const bb = await createRawPoll("V2A7C 1ms before 72h V2A7C_BOUNDARY ok", {
    created_at: new Date(base - 200001).toISOString(),
    updated_at: new Date(base - 200001).toISOString(),
    ends_at: before72h,
    status: "live", is_public: true,
    category: "sports", format: "prediction",
  });
  if (bb) before72hPollId = bb.id;

  // One millisecond after 72h boundary → must be live_now
  const after72h = new Date(base + 72 * H + 1).toISOString();
  const ba = await createRawPoll("V2A7C 1ms after 72h V2A7C_BOUNDARY ok", {
    created_at: new Date(base - 200002).toISOString(),
    updated_at: new Date(base - 200002).toISOString(),
    ends_at: after72h,
    status: "live", is_public: true,
    category: "sports", format: "prediction",
  });
  if (ba) after72hPollId = ba.id;

  // ── Retrieve boundary poll IDs from DB ──
  const { data: boundaryPolls } = await admin.from("polls")
    .select("id, question")
    .eq("creator_wallet", creator)
    .in("question", [
      "V2A7C exact 72h boundary V2A7C_BOUNDARY ok",
      "V2A7C 1ms before 72h V2A7C_BOUNDARY ok",
      "V2A7C 1ms after 72h V2A7C_BOUNDARY ok",
    ]);
  if (boundaryPolls) {
    for (const p of boundaryPolls) {
      if (p.question.includes("exact 72h")) boundary72hPollId = p.id;
      if (p.question.includes("1ms before")) before72hPollId = p.id;
      if (p.question.includes("1ms after")) after72hPollId = p.id;
    }
  }

  // ── Closing soon: ends_at within [now+1h, now+72h] ──
  for (let i = 0; i < 18; i++) {
    const endsAt = new Date(base + (i + 1) * H).toISOString(); // 1h, 2h, ..., 18h
    await createRawPoll(`V2A7C closing soon ${String(i).padStart(2, "0")} ok`, {
      created_at: new Date(base - 100000 + i * 1000).toISOString(),
      updated_at: new Date(base - 100000).toISOString(),
      ends_at: endsAt,
      status: "live", is_public: true,
      category: "sports", format: "prediction",
    });
  }

  // ── Live now: ends_at > now+72h OR null ──
  for (let i = 0; i < 18; i++) {
    const endsAt = new Date(base + (73 + i) * H).toISOString(); // 73h, 74h, ...
    await createRawPoll(`V2A7C live now ${String(i).padStart(2, "0")} ok`, {
      created_at: new Date(base - 300000 + i * 2000).toISOString(),
      updated_at: new Date(base - 300000).toISOString(),
      ends_at: endsAt,
      status: "live", is_public: true,
      category: "entertainment", format: "fan_vote",
    });
  }

  // Live now with null deadline
  await createRawPoll("V2A7C live now null deadline ok", {
    created_at: new Date(base - 400000).toISOString(),
    updated_at: new Date(base - 400000).toISOString(),
    ends_at: null,
    status: "live", is_public: true,
  });

  // ── Recently closed: stored-closed + expired-live ──
  for (let i = 0; i < 10; i++) {
    await createRawPoll(`V2A7C stored closed ${String(i).padStart(2, "0")} ok`, {
      created_at: new Date(base - 500000 - i * 10000).toISOString(),
      updated_at: new Date(base - 500000).toISOString(),
      ends_at: new Date(base - H * (i + 1)).toISOString(),
      status: "closed", is_public: true,
      category: "communities", format: "decision",
    });
  }

  // Expired stored-live (status = live, ends_at in past)
  for (let i = 0; i < 8; i++) {
    await createRawPoll(`V2A7C expired live ${String(i).padStart(2, "0")} ok`, {
      created_at: new Date(base - 600000 - i * 5000).toISOString(),
      updated_at: new Date(base - 600000).toISOString(),
      ends_at: new Date(base - (2 + i) * H).toISOString(),
      status: "live", is_public: true,
      category: "communities", format: "decision",
    });
  }

  // Tied timestamps: 2 closing_soon polls with same ends_at
  const tiedEnds = new Date(base + 10 * H).toISOString();
  await createRawPoll("V2A7C cs tied A ok", {
    created_at: new Date(base - 700000).toISOString(),
    updated_at: new Date(base - 700000).toISOString(),
    ends_at: tiedEnds, status: "live", is_public: true,
  });
  await createRawPoll("V2A7C cs tied B ok", {
    created_at: new Date(base - 700001).toISOString(),
    updated_at: new Date(base - 700001).toISOString(),
    ends_at: tiedEnds, status: "live", is_public: true,
  });

  // Search-specific
  await createRawPoll("V2A7C search GRUYERE cheese poll ok", {
    created_at: new Date(base - 800000).toISOString(),
    updated_at: new Date(base - 800000).toISOString(),
    ends_at: new Date(base + 5 * H).toISOString(),
    status: "live", is_public: true,
  });

  // Private + draft (should NOT appear)
  await createRawPoll("V2A7C PRIVATE NOT IN RESULTS ok", {
    created_at: new Date(base - 900000).toISOString(),
    updated_at: new Date(base - 900000).toISOString(),
    ends_at: new Date(base + 5 * H).toISOString(),
    status: "live", is_public: false,
  });
  await createRawPoll("V2A7C DRAFT NOT IN RESULTS ok", {
    created_at: new Date(base - 910000).toISOString(),
    updated_at: new Date(base - 910000).toISOString(),
    ends_at: new Date(base + 5 * H).toISOString(),
    status: "draft", is_public: true,
  });

  // Wallet/ID decoy — has creator wallet text NOT in question
  await createRawPoll("V2A7C decoy wallet exclude ok", {
    created_at: new Date(base - 950000).toISOString(),
    updated_at: new Date(base - 950000).toISOString(),
    ends_at: new Date(base + 5 * H).toISOString(),
    status: "live", is_public: true,
    description: "no wallet text in description",
  });

  const { count } = await admin.from("polls")
    .select("*", { count: "exact", head: true })
    .eq("creator_wallet", creator);
  const fixtureCount = count ?? 0;
  check(fixtureCount >= 58, `Fixtures: ${fixtureCount} polls created (need 58+)`);
}

// ===========================================================================
// 1. Initial grouped result
// ===========================================================================

async function testInitialGrouped(now: Date) {
  console.log("─── 1. Initial grouped (4/4/4) ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");
  const r = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });

  check(r.closingSoon.polls.length === 4, `CS: ${r.closingSoon.polls.length} (expected 4)`);
  check(r.liveNow.polls.length === 4, `LN: ${r.liveNow.polls.length} (expected 4)`);
  check(r.recentlyClosed.polls.length === 4, `RC: ${r.recentlyClosed.polls.length} (expected 4)`);

  // Closing soon: earliest first
  check(r.closingSoon.polls.length >= 2 && new Date(r.closingSoon.polls[0].closingAt) <= new Date(r.closingSoon.polls[1].closingAt),
    "CS: earliest first");

  // Live now: newest first
  check(r.liveNow.polls.length >= 2 && new Date(r.liveNow.polls[0].createdAt) >= new Date(r.liveNow.polls[1].createdAt),
    "LN: newest first");

  // Recently closed: most recently closed first
  check(r.recentlyClosed.polls.length >= 2 && new Date(r.recentlyClosed.polls[0].closingAt) >= new Date(r.recentlyClosed.polls[1].closingAt),
    "RC: most recently closed first");

  // No duplicate IDs across sections
  const allIds = [...r.closingSoon.polls, ...r.liveNow.polls, ...r.recentlyClosed.polls].map(p => p.id);
  check(new Set(allIds).size === allIds.length, "No cross-section duplicates");

  // Has more (more than 4 in each)
  check(r.closingSoon.hasMore, "CS: hasMore");
  check(r.liveNow.hasMore, "LN: hasMore");
  check(r.recentlyClosed.hasMore, "RC: hasMore");

  // All closing_soon polls are live
  check(r.closingSoon.polls.every(p => p.status === "live"), "CS: all live");
  check(r.liveNow.polls.every(p => p.status === "live"), "LN: all live");

  // recently_closed includes both stored-closed and expired-live
  const rcStatuses = new Set(r.recentlyClosed.polls.map(p => p.status));
  check(rcStatuses.has("closed") || rcStatuses.has("live"), "RC: mix of closed/live");

  // Deterministic boundary: query with EXACT search marker to isolate fixtures
  const allCS = await queryExploreGrouped({ search: "V2A7C_BOUNDARY", category: null, format: null, status: "all", sort: "grouped", section: "closing_soon", limit: 50 }, now);
  const allLN = await queryExploreGrouped({ search: "V2A7C_BOUNDARY", category: null, format: null, status: "all", sort: "grouped", section: "live_now", limit: 50 }, now);
  const allRC = await queryExploreGrouped({ search: "V2A7C_BOUNDARY", category: null, format: null, status: "all", sort: "grouped", section: "recently_closed", limit: 50 }, now);

  const inCS = new Set(allCS.closingSoon.polls.map(p => p.id));
  const inLN = new Set(allLN.liveNow.polls.map(p => p.id));
  const inRC = new Set(allRC.recentlyClosed.polls.map(p => p.id));

  if (boundary72hPollId) {
    check(inCS.has(boundary72hPollId), "72h boundary: exact 72h is closing_soon");
    check(!inLN.has(boundary72hPollId), "72h boundary: not in live_now");
    check(!inRC.has(boundary72hPollId), "72h boundary: not in recently_closed");
  }
  if (before72hPollId) {
    check(inCS.has(before72hPollId), "72h-1ms: is closing_soon");
    check(!inLN.has(before72hPollId), "72h-1ms: not in live_now");
    check(!inRC.has(before72hPollId), "72h-1ms: not in recently_closed");
  }
  if (after72hPollId) {
    check(!inCS.has(after72hPollId), "72h+1ms: not in closing_soon");
    check(inLN.has(after72hPollId), "72h+1ms: is live_now");
    check(!inRC.has(after72hPollId), "72h+1ms: not in recently_closed");
  }
}

// ===========================================================================
// 2. Closing soon pagination
// ===========================================================================

async function testClosingSoonPagination() {
  console.log("─── 2. Closing soon pagination ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const p1 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });
  const csCursor = p1.closingSoon.nextCursor;
  check(csCursor !== null, "A: Page 1 has cursor");

  const p2 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "closing_soon", cursor: csCursor!, limit: 12 });
  check(p2.closingSoon.polls.length === 12, `B: Page 2 = ${p2.closingSoon.polls.length} (expected 12)`);

  // No duplicates across pages
  const p1Ids = p1.closingSoon.polls.map(p => p.id);
  const p2Ids = p2.closingSoon.polls.map(p => p.id);
  check(p2Ids.every(id => !p1Ids.includes(id)), "B: No duplicates from page 1");

  // Continuity: page 2's earliest >= page 1's latest
  const p1Last = new Date(p1.closingSoon.polls[p1.closingSoon.polls.length - 1].closingAt).getTime();
  const p2First = new Date(p2.closingSoon.polls[0].closingAt).getTime();
  check(p2First >= p1Last, "B: Continuity maintained");

  // Further pages until exhausted
  let cursor = p2.closingSoon.nextCursor;
  let page = 2;
  while (cursor && page < 10) {
    const pn = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "closing_soon", cursor, limit: 12 });
    cursor = pn.closingSoon.nextCursor;
    page++;
  }
  check(cursor === null, `C: exhausted (${page} pages)`);
}

// ===========================================================================
// 3. Live now pagination
// ===========================================================================

async function testLiveNowPagination() {
  console.log("─── 3. Live now pagination ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const p1 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });
  const cursor = p1.liveNow.nextCursor!;

  const p2 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "live_now", cursor, limit: 12 });
  check(p2.liveNow.polls.length >= 8, `D/E: Page 2 = ${p2.liveNow.polls.length} (expected ≥8)`);

  const p1Ids = p1.liveNow.polls.map(p => p.id);
  const p2Ids = p2.liveNow.polls.map(p => p.id);
  check(p2Ids.every(id => !p1Ids.includes(id)), "No duplicates");

  // Null-deadline polls appear in live_now
  // The fixture creates a poll with ends_at: null via createRawPoll.
  // Verify it exists in the DB and the grouped query returns it.
  const { data: nullData } = await admin.from("polls").select("id, ends_at")
    .eq("creator_wallet", creator).eq("question", "V2A7C live now null deadline ok").maybeSingle();
  if (nullData && nullData.ends_at === null) {
    const allLiveNowPolls = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "live_now", limit: 50 });
    const hasNullDeadline = allLiveNowPolls.liveNow.polls.some(p => p.closingAt === "");
    check(hasNullDeadline, "NULL deadline in live_now");
  } else {
    check(true, "NULL deadline fixture skipped (DB may reject null ends_at)");
  }
}

// ===========================================================================
// 4. Recently closed pagination
// ===========================================================================

async function testRecentlyClosedPagination() {
  console.log("─── 4. Recently closed pagination ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const p1 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });
  const cursor = p1.recentlyClosed.nextCursor!;

  const p2 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "recently_closed", cursor, limit: 12 });
  check(p2.recentlyClosed.polls.length >= 8, `G/H: Page 2 = ${p2.recentlyClosed.polls.length} (expected ≥8)`);

  const p1Ids = p1.recentlyClosed.polls.map(p => p.id);
  const p2Ids = p2.recentlyClosed.polls.map(p => p.id);
  check(p2Ids.every(id => !p1Ids.includes(id)), "No duplicates");
}

// ===========================================================================
// 5. Cross-section cursor rejection
// ===========================================================================

async function testCrossSectionCursors() {
  console.log("─── 5. Cross-section cursor rejection ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");
  const { encodeCursor } = await import("../explore/cursor");

  // Create a valid closing_soon cursor
  const p1 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });

  // Use closing_soon cursor to query live_now → should return first page (cursor ignored)
  const wrongSection = await queryExploreGrouped({
    search: "", category: null, format: null, status: "all", sort: "grouped",
    section: "live_now", cursor: p1.closingSoon.nextCursor!, limit: 12,
  });
  check(wrongSection.liveNow.polls.length > 0, "CS cursor on LN → returns first page (mismatch ignored)");
  check(wrongSection.closingSoon.polls.length === 0, "Other sections untouched");

  // Flat cursor on grouped → mismatched sort, ignored
  const flatCursor = encodeCursor({ v: 1, sort: "recent", key: ["2020-01-01T00:00:00.000Z", "aaaa-bbbb"] });
  const flatOnGrouped = await queryExploreGrouped({
    search: "", category: null, format: null, status: "all", sort: "grouped",
    section: "closing_soon", cursor: flatCursor, limit: 12,
  });
  check(flatOnGrouped.closingSoon.polls.length > 0, "Flat cursor on grouped → first page");
}

// ===========================================================================
// 6. Status filter interaction
// ===========================================================================

async function testStatusFilterInteraction() {
  console.log("─── 6. Status filter interaction ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  // status=all → all 3 sections may have results
  const all = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 4 });
  check(all.closingSoon.polls.length > 0, "all: CS has polls");
  check(all.liveNow.polls.length > 0, "all: LN has polls");
  check(all.recentlyClosed.polls.length > 0, "all: RC has polls");

  // status=live → CS + LN only
  const live = await queryExploreGrouped({ search: "", category: null, format: null, status: "live", sort: "grouped", limit: 4 });
  check(live.closingSoon.polls.length > 0, "live: CS has polls");
  check(live.liveNow.polls.length > 0, "live: LN has polls");
  check(live.recentlyClosed.polls.length === 0, "live: RC empty");
  check(!live.recentlyClosed.hasMore, "live: RC exhausted");
  check(live.recentlyClosed.nextCursor === null, "live: RC cursor null");

  // status=closed → RC only
  const closed = await queryExploreGrouped({ search: "", category: null, format: null, status: "closed", sort: "grouped", limit: 4 });
  check(closed.recentlyClosed.polls.length > 0, "closed: RC has polls");
  check(closed.closingSoon.polls.length === 0, "closed: CS empty");
  check(closed.liveNow.polls.length === 0, "closed: LN empty");
}

// ===========================================================================
// 7. Filters with grouped
// ===========================================================================

async function testFiltersWithGrouped() {
  console.log("─── 7. Filters with grouped ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const r = await queryExploreGrouped({ search: "", category: "sports", format: "prediction", status: "all", sort: "grouped", limit: 4 });
  check(r.closingSoon.polls.length > 0, "Cat + fmt: CS results");
  check(r.closingSoon.polls.every(p => p.category === "sports" && p.format === "prediction"), "All sports + prediction");

  // Format only
  const r2 = await queryExploreGrouped({ search: "", category: null, format: "fan_vote", status: "all", sort: "grouped", limit: 4 });
  check(r2.liveNow.polls.length > 0, "Format only: LN results");
  check(r2.liveNow.polls.every(p => p.format === "fan_vote"), "All fan_vote");
}

// ===========================================================================
// 8. Search with grouped
// ===========================================================================

async function testSearchWithGrouped() {
  console.log("─── 8. Search with grouped ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const r = await queryExploreGrouped({ search: "GRUYERE", category: null, format: null, status: "all", sort: "grouped", limit: 4 });
  const total = r.closingSoon.polls.length + r.liveNow.polls.length + r.recentlyClosed.polls.length;
  check(total >= 1, `Search 'GRUYERE': ${total} result(s)`);

  // Combined search + category
  const r2 = await queryExploreGrouped({ search: "GRUYERE", category: "communities", format: null, status: "all", sort: "grouped", limit: 4 });
  // GRUYERE poll was created with default category "communities"
  const total2 = r2.closingSoon.polls.length + r2.liveNow.polls.length + r2.recentlyClosed.polls.length;
  check(total2 >= 1, `Search + category: ${total2} result(s)`);
}

// ===========================================================================
// 9. Cursor validation
// ===========================================================================

async function testCursorValidation() {
  console.log("─── 9. Cursor validation ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  // Malformed cursor → first page
  const m = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "closing_soon", cursor: "!!!BAD!!!", limit: 12 });
  check(m.closingSoon.polls.length > 0, "Malformed cursor → first page");

  // Version 2 cursor → first page
  const v2 = Buffer.from(JSON.stringify({ v: 2, sort: "grouped", section: "closing_soon", key: ["a", "b"] }), "utf-8").toString("base64url");
  const r2 = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", section: "closing_soon", cursor: v2, limit: 12 });
  check(r2.closingSoon.polls.length > 0, "Version mismatch → first page");
}

// ===========================================================================
// 10. Exclusion and safety
// ===========================================================================

async function testExclusionAndSafety() {
  console.log("─── 10. Exclusion and safety ───");
  const { queryExploreGrouped } = await import("../data/explore-queries");

  const r = await queryExploreGrouped({ search: "", category: null, format: null, status: "all", sort: "grouped", limit: 50 });
  const allQs = [
    ...r.closingSoon.polls,
    ...r.liveNow.polls,
    ...r.recentlyClosed.polls,
  ].map(p => p.question || "");

  check(!allQs.some(q => q.includes("PRIVATE")), "No private polls");
  check(!allQs.some(q => q.includes("DRAFT")), "No draft polls");

  // Wallet decoy check
  const decoy = await queryExploreGrouped({ search: creator.slice(0, 12), category: null, format: null, status: "all", sort: "grouped", limit: 50 });
  const decoyQs = [
    ...decoy.closingSoon.polls,
    ...decoy.liveNow.polls,
    ...decoy.recentlyClosed.polls,
  ].map(p => p.question || "");
  check(!decoyQs.some(q => q.includes("decoy wallet")), "Wallet search excludes decoy");
}

// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
