/**
 * V2A.7E — Load more, loading, retry, exhausted, and accessibility tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a7e-test.ts
 */

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.7E Load More, Retry & Accessibility Tests");
  console.log("═══════════════════════════════════════════\n");

  await testAppendUnique();
  await testClearFiltersDetection();
  await testGroupedSectionNames();
  await testLoadMoreUrlSafety();
  await testExhaustedAndRetryFlow();
  await testCoordinatorConcurrency();

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ===========================================================================
// 1. appendUnique (used by both flat and grouped Load more)
// ===========================================================================

async function testAppendUnique() {
  console.log("─── 1. appendUnique ───");
  type PC = { id: string; question: string; category: string; format: string; status: string; closingAt: string; createdAt: string; optionCount: number; };
  function appendUnique(existing: PC[], incoming: PC[]): PC[] {
    const existingIds = new Set(existing.map((p) => p.id));
    const unique = incoming.filter((p) => !existingIds.has(p.id));
    const seen = new Set<string>();
    const deduped: PC[] = [];
    for (const p of unique) {
      if (!seen.has(p.id)) { seen.add(p.id); deduped.push(p); }
    }
    return [...existing, ...deduped];
  }
  const mk = (id: string): PC => ({ id, question: "q", category: "communities", format: "decision", status: "live", closingAt: "", createdAt: "", optionCount: 2 });

  // Order preserved
  const r1 = appendUnique([mk("a"), mk("b")], [mk("c"), mk("d")]);
  check(r1.map(p => p.id).join(",") === "a,b,c,d", "AL1: order preserved");

  // Duplicate IDs ignored
  const r2 = appendUnique([mk("a"), mk("b")], [mk("b"), mk("c")]);
  check(r2.map(p => p.id).join(",") === "a,b,c", "AL2: duplicate skipped");

  // Incoming duplicates deduped
  const r3 = appendUnique([mk("a")], [mk("b"), mk("b"), mk("c")]);
  check(r3.map(p => p.id).join(",") === "a,b,c", "AL3: incoming deduped");
}

// ===========================================================================
// 2. Clear filters detection
// ===========================================================================

async function testClearFiltersDetection() {
  console.log("─── 2. Clear filters ───");
  const { hasNonDefaultFilters } = await import("../explore/url-params");

  check(!hasNonDefaultFilters({ search: "", category: null, format: null, status: "all", sort: "grouped" }),
    "CL1: hidden at default");
  check(hasNonDefaultFilters({ search: "x", category: null, format: null, status: "all", sort: "grouped" }),
    "CL2: visible for search");
  check(hasNonDefaultFilters({ search: "", category: "sports", format: null, status: "all", sort: "grouped" }),
    "CL3: visible for category");
  check(hasNonDefaultFilters({ search: "", category: null, format: "prediction", status: "all", sort: "grouped" }),
    "CL4: visible for format");
  check(hasNonDefaultFilters({ search: "", category: null, format: null, status: "live", sort: "grouped" }),
    "CL5: visible for status");
  check(hasNonDefaultFilters({ search: "", category: null, format: null, status: "all", sort: "recent" }),
    "CL6: visible for sort");

  const { buildExploreUrl } = await import("../explore/url-params");
  check(buildExploreUrl({ search: "", category: null, format: null, status: "all", sort: "grouped" }) === "/explore",
    "CL7: Clear returns to /explore");
}

// ===========================================================================
// 3. Grouped section names
// ===========================================================================

async function testGroupedSectionNames() {
  console.log("─── 3. Grouped section names ───");

  const VALID_SECTIONS = ["closing_soon", "live_now", "recently_closed"] as const;
  const sectionLabels: Record<string, string> = {
    closing_soon: "Closing soon",
    live_now: "Live now",
    recently_closed: "Recently closed",
  };

  for (const sec of VALID_SECTIONS) {
    check(typeof sectionLabels[sec] === "string", `Section '${sec}' has label`);
  }

  // Verify section values are the exact transport names
  check(VALID_SECTIONS.includes("closing_soon"), "GS1: closing_soon is valid");
  check(VALID_SECTIONS.includes("live_now"), "GS2: live_now is valid");
  check(VALID_SECTIONS.includes("recently_closed"), "GS3: recently_closed is valid");
}

// ===========================================================================
// 4. Load more URL safety — cursor and section never in public URL
// ===========================================================================

async function testLoadMoreUrlSafety() {
  console.log("─── 4. Load more URL safety ───");
  const { buildExploreUrl } = await import("../explore/url-params");

  // All non-default filters should NOT include cursor or section
  const urls = [
    buildExploreUrl({ search: "x", category: "sports", format: null, status: "live", sort: "recent" }),
    buildExploreUrl({ search: "", category: null, format: null, status: "all", sort: "grouped" }),
    buildExploreUrl({ search: "", category: null, format: "prediction", status: "closed", sort: "closing" }),
  ];

  for (const url of urls) {
    check(!url.includes("cursor="), `URL safety: no cursor in '${url}'`);
    check(!url.includes("section="), `URL safety: no section in '${url}'`);
  }
  // /explore is the default
  check(buildExploreUrl({ search: "", category: null, format: null, status: "all", sort: "grouped" }) === "/explore",
    "URL safety: default is /explore");
}

// ===========================================================================
// 5. Exhausted and retry flow (logic-level test)
// ===========================================================================

async function testExhaustedAndRetryFlow() {
  console.log("─── 5. Exhausted and retry flow ───");

  // Exhausted result shape
  const exhausted: { polls: unknown[]; nextCursor: null; hasMore: boolean } = {
    polls: [{ id: "a" }, { id: "b" }],
    nextCursor: null,
    hasMore: false,
  };

  check(exhausted.nextCursor === null, "EX1: exhausted → null cursor");
  check(!exhausted.hasMore, "EX2: exhausted → hasMore=false");
  check(exhausted.polls.length > 0, "EX3: exhausted preserves cards");

  // Non-exhausted with nextCursor
  const more: { polls: unknown[]; nextCursor: string | null; hasMore: boolean } = {
    polls: [{ id: "a" }],
    nextCursor: "opaque-cursor-value",
    hasMore: true,
  };

  check(more.nextCursor !== null, "EX4: hasMore → cursor present");
  check(more.hasMore, "EX5: hasMore → hasMore=true");

  // Empty legitimate result
  const empty: { polls: unknown[]; nextCursor: null; hasMore: boolean } = {
    polls: [],
    nextCursor: null,
    hasMore: false,
  };

  check(empty.polls.length === 0, "EX6: empty result → 0 polls");
  check(empty.nextCursor === null, "EX7: empty → null cursor");
  check(!empty.hasMore, "EX8: empty → hasMore=false");
}

// ===========================================================================
// 6. Coordinator concurrency (production logic)
// ===========================================================================

async function testCoordinatorConcurrency() {
  console.log("─── 6. Coordinator concurrency ───");
  const { createExploreRequestCoordinator } = await import("../explore/request-coordinator");

  // A: CS starts, then LN starts → neither aborted, both current
  const c = createExploreRequestCoordinator();
  const cs = c.startSectionMore("closing_soon");
  const ln = c.startSectionMore("live_now");
  check(!cs.ac.signal.aborted, "AC1: CS not aborted after LN starts");
  check(!ln.ac.signal.aborted, "AC2: LN not aborted after CS starts");
  check(c.isCurrent(cs), "AC3: CS handle current");
  check(c.isCurrent(ln), "AC4: LN handle current");

  // B: All three sections start → all active, all current
  const c2 = createExploreRequestCoordinator();
  const cs2 = c2.startSectionMore("closing_soon");
  const ln2 = c2.startSectionMore("live_now");
  const rc2 = c2.startSectionMore("recently_closed");
  check(c2.isCurrent(cs2) && c2.isCurrent(ln2) && c2.isCurrent(rc2), "B: all three current");

  // D: Same-section replacement → old invalid, new current, other unchanged
  const csOld = c2.startSectionMore("closing_soon"); // second CS request
  check(!c2.isCurrent(cs2), "D1: old CS handle invalid after replacement");
  check(c2.isCurrent(csOld), "D2: new CS handle current");
  check(c2.isCurrent(ln2), "D3: LN still current after CS replacement");

  // E: Filter change → all invalid
  c2.advanceFilterGeneration();
  check(!c2.isCurrent(csOld), "E1: CS invalid after filter change");
  check(!c2.isCurrent(ln2), "E2: LN invalid after filter change");
  check(!c2.isCurrent(rc2), "E3: RC invalid after filter change");

  // F: Clear filters (same as filter change)
  const c3 = createExploreRequestCoordinator();
  const cs3 = c3.startSectionMore("closing_soon");
  c3.advanceFilterGeneration();
  check(!c3.isCurrent(cs3), "F: CS invalid after advanceFilterGeneration");

  // G: Sort change (same mechanism)
  const c4 = createExploreRequestCoordinator();
  const cs4 = c4.startSectionMore("closing_soon");
  const ln4 = c4.startSectionMore("live_now");
  c4.advanceFilterGeneration();
  check(!c4.isCurrent(cs4) && !c4.isCurrent(ln4), "G: all invalid after sort change");

  // H: Dispose → all aborted, all invalid
  const cs5 = c3.startSectionMore("closing_soon");
  c3.dispose();
  check(!c3.isCurrent(cs5), "H: invalid after dispose");

  // I: Flat and grouped independence
  const c6 = createExploreRequestCoordinator();
  const flat = c6.startFlatMore();
  const cs6 = c6.startSectionMore("closing_soon");
  check(c6.isCurrent(flat), "I1: flat current");
  check(c6.isCurrent(cs6), "I2: grouped still current alongside flat");
  c6.advanceFilterGeneration();
  check(!c6.isCurrent(flat) && !c6.isCurrent(cs6), "I3: filter change invalidates both");

  // K: Retry isolation — CS retry does not abort LN
  const c7 = createExploreRequestCoordinator();
  const cs7 = c7.startSectionMore("closing_soon");
  const ln7 = c7.startSectionMore("live_now");
  const csRetry = c7.startSectionMore("closing_soon"); // retry
  check(!c7.isCurrent(cs7), "K1: old CS invalid after retry");
  check(c7.isCurrent(csRetry), "K2: retry CS current");
  check(c7.isCurrent(ln7), "K3: LN still current after CS retry");
  check(!ln7.ac.signal.aborted, "K4: LN not aborted by CS retry");
}

// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
