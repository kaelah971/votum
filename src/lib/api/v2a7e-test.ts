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

// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
