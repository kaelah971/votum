/**
 * V2A.7A — Query Contracts and Canonical URL Model Tests
 *
 * Usage:
 *   npx tsx src/lib/api/v2a7a-test.ts
 */

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.7A Query Contracts and URL Model Tests");
  console.log("═══════════════════════════════════════════\n");

  await testUrlParsing();
  await testUrlBuilding();
  await testHasNonDefaultFilters();
  await testCursorEncoding();

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ===========================================================================
// 1. URL PARSING — parseExploreParams
// ===========================================================================

async function testUrlParsing() {
  console.log("─── 1. URL parsing ───");

  const { parseExploreParams } = await import("../explore/url-params");

  // ── A. Default filter parsing (empty params → all defaults) ─────────
  const a = parseExploreParams(new URLSearchParams(""));
  check(a.search === "", "A1: Default search = ''");
  check(a.category === null, "A2: Default category = null");
  check(a.format === null, "A3: Default format = null");
  check(a.status === "all", "A4: Default status = 'all'");
  check(a.sort === "grouped", "A5: Default sort = 'grouped'");

  // Params with only whitespace
  const a2 = parseExploreParams(new URLSearchParams("q=+++"));
  check(a2.search === "", "A6: Whitespace-only search → ''");

  // ── B. Valid category ──────────────────────────────────────────────
  const b = parseExploreParams(new URLSearchParams("category=sports"));
  check(b.category === "sports", "B1: category = 'sports'");
  check(b.status === "all", "B2: Other fields remain default");

  const b2 = parseExploreParams(new URLSearchParams("category=entertainment"));
  check(b2.category === "entertainment", "B3: category = 'entertainment'");

  const b3 = parseExploreParams(new URLSearchParams("category=brands_products"));
  check(b3.category === "brands_products", "B4: category = 'brands_products'");

  const b4 = parseExploreParams(new URLSearchParams("category=communities"));
  check(b4.category === "communities", "B5: category = 'communities'");

  const b5 = parseExploreParams(new URLSearchParams("category=other"));
  check(b5.category === "other", "B6: category = 'other'");

  // ── C. Valid format ────────────────────────────────────────────────
  const c = parseExploreParams(new URLSearchParams("format=prediction"));
  check(c.format === "prediction", "C1: format = 'prediction'");

  const c2 = parseExploreParams(new URLSearchParams("format=decision"));
  check(c2.format === "decision", "C2: format = 'decision'");

  const c3 = parseExploreParams(new URLSearchParams("format=fan_vote"));
  check(c3.format === "fan_vote", "C3: format = 'fan_vote'");

  const c4 = parseExploreParams(new URLSearchParams("format=ranking"));
  check(c4.format === "ranking", "C4: format = 'ranking'");

  const c5 = parseExploreParams(new URLSearchParams("format=nomination"));
  check(c5.format === "nomination", "C5: format = 'nomination'");

  const c6 = parseExploreParams(new URLSearchParams("format=audience_choice"));
  check(c6.format === "audience_choice", "C6: format = 'audience_choice'");

  // ── D. Valid status ────────────────────────────────────────────────
  const d = parseExploreParams(new URLSearchParams("status=live"));
  check(d.status === "live", "D1: status = 'live'");

  const d2 = parseExploreParams(new URLSearchParams("status=closed"));
  check(d2.status === "closed", "D2: status = 'closed'");

  // ── E. Valid sort ──────────────────────────────────────────────────
  const e = parseExploreParams(new URLSearchParams("sort=recent"));
  check(e.sort === "recent", "E1: sort = 'recent'");

  const e2 = parseExploreParams(new URLSearchParams("sort=closing"));
  check(e2.sort === "closing", "E2: sort = 'closing'");

  const e3 = parseExploreParams(new URLSearchParams("sort=grouped"));
  check(e3.sort === "grouped", "E3: explicit grouped accepted");

  // ── F. Valid combined state ────────────────────────────────────────
  const f = parseExploreParams(
    new URLSearchParams("q=who+will+win&category=sports&format=prediction&status=live&sort=closing"),
  );
  check(f.search === "who will win", "F1: Combined search extracted");
  check(f.category === "sports", "F2: Combined category extracted");
  check(f.format === "prediction", "F3: Combined format extracted");
  check(f.status === "live", "F4: Combined status extracted");
  check(f.sort === "closing", "F5: Combined sort extracted");

  // ── G. Trimmed search ──────────────────────────────────────────────
  const g = parseExploreParams(new URLSearchParams("q=++hello+world++"));
  check(g.search === "hello world", "G1: Surrounding whitespace trimmed");

  const g2 = parseExploreParams(new URLSearchParams("q=%20%20test%20%20"));
  check(g2.search === "test", "G2: URL-encoded whitespace trimmed");

  // ── H. Empty search (after trimming) → default ──────────────────────
  const h = parseExploreParams(new URLSearchParams("q=   "));
  check(h.search === "", "H1: Whitespace-only search becomes ''");

  // ── I. Search maximum length ───────────────────────────────────────
  const longStr = "x".repeat(300);
  const i = parseExploreParams(new URLSearchParams(`q=${longStr}`));
  check(i.search.length === 200, `I1: Search clamped to 200 (got ${i.search.length})`);
  check(i.search === "x".repeat(200), "I2: Search content is first 200 chars");

  // ── J. Invalid category → dropped ──────────────────────────────────
  const j = parseExploreParams(new URLSearchParams("category=nonsense"));
  check(j.category === null, "J1: Invalid category → null");

  const j2 = parseExploreParams(new URLSearchParams("category=SPORTS"));
  check(j2.category === null, "J2: 'SPORTS' (uppercase) → null (exact match only)");

  const j3 = parseExploreParams(new URLSearchParams("category="));
  check(j3.category === null, "J3: Empty category → null");

  // ── K. Invalid format → dropped ────────────────────────────────────
  const k = parseExploreParams(new URLSearchParams("format=bogus"));
  check(k.format === null, "K1: Invalid format → null");

  const k2 = parseExploreParams(new URLSearchParams("format=PREDICTION"));
  check(k2.format === null, "K2: 'PREDICTION' (uppercase) → null");

  // ── L. Invalid status → dropped ─────────────────────────────────────
  const l = parseExploreParams(new URLSearchParams("status=draft"));
  check(l.status === "all", "L1: 'draft' → default 'all'");

  const l2 = parseExploreParams(new URLSearchParams("status=cancelled"));
  check(l2.status === "all", "L2: 'cancelled' → default 'all'");

  const l3 = parseExploreParams(new URLSearchParams("status=ALL"));
  check(l3.status === "all", "L3: 'ALL' → default (not valid status)");

  // ── M. Invalid sort → dropped ──────────────────────────────────────
  const m = parseExploreParams(new URLSearchParams("sort=newest"));
  check(m.sort === "grouped", "M1: 'newest' → default 'grouped'");

  const m2 = parseExploreParams(new URLSearchParams("sort=RECENT"));
  check(m2.sort === "grouped", "M2: 'RECENT' → default 'grouped'");

  // ── N. Preservation of other valid parameters ───────────────────────
  const n = parseExploreParams(
    new URLSearchParams("q=test&category=invalid_cat&format=prediction&status=bad&sort=recent"),
  );
  check(n.search === "test", "N1: Valid search preserved");
  check(n.category === null, "N2: Invalid category dropped");
  check(n.format === "prediction", "N3: Valid format preserved");
  check(n.status === "all", "N4: Invalid status dropped");
  check(n.sort === "recent", "N5: Valid sort preserved");
}

// ===========================================================================
// 2. URL BUILDING — buildExploreUrl
// ===========================================================================

async function testUrlBuilding() {
  console.log("─── 2. URL building ───");

  const { buildExploreUrl } = await import("../explore/url-params");
  const { parseExploreParams } = await import("../explore/url-params");

  // ── O. Defaults omitted → /explore ──────────────────────────────────
  const o = buildExploreUrl({
    search: "",
    category: null,
    format: null,
    status: "all",
    sort: "grouped",
  });
  check(o === "/explore", `O1: All defaults → '${o}'`);

  // ── P. Deterministic parameter ordering ────────────────────────────
  const p = buildExploreUrl({
    search: "test",
    category: "sports",
    format: "prediction",
    status: "live",
    sort: "closing",
  });
  check(p === "/explore?q=test&category=sports&format=prediction&status=live&sort=closing",
    `P1: Order is q,category,format,status,sort → '${p}'`);

  // Partial: status + sort
  const p2 = buildExploreUrl({
    search: "",
    category: null,
    format: null,
    status: "live",
    sort: "recent",
  });
  check(p2 === "/explore?status=live&sort=recent",
    `P2: Only non-defaults in correct order → '${p2}'`);

  // ── Round-trip: parse → build → parse yields identical state ───────
  function roundTrip(url: string): boolean {
    const state1 = parseExploreParams(new URLSearchParams(url));
    const built = buildExploreUrl(state1);
    const queryPart = built === "/explore" ? "" : built.slice("/explore?".length);
    const state2 = parseExploreParams(new URLSearchParams(queryPart));
    return (
      state1.search === state2.search &&
      state1.category === state2.category &&
      state1.format === state2.format &&
      state1.status === state2.status &&
      state1.sort === state2.sort
    );
  }

  check(roundTrip(""), "P3: Round-trip: empty → empty");
  check(roundTrip("category=sports"), "P4: Round-trip: category only");
  check(roundTrip("q=test&format=prediction&status=closed"), "P5: Round-trip: search + format + status");
  check(roundTrip("category=sports&format=prediction&status=live&sort=recent"), "P6: Round-trip: full non-default");

  // ── Edge: whitespace-only search omitted ────────────────────────────
  const whitespaceUrl = buildExploreUrl({
    search: "   ",
    category: null,
    format: null,
    status: "all",
    sort: "grouped",
  });
  check(whitespaceUrl === "/explore", `P7: Whitespace search omitted → '${whitespaceUrl}'`);

  // ── Edge: trailing/leading whitespace trimmed in URL ────────────────
  const trimmedUrl = buildExploreUrl({
    search: "  hello  ",
    category: null,
    format: null,
    status: "all",
    sort: "grouped",
  });
  check(trimmedUrl === "/explore?q=hello", `P8: Trimmed search in URL → '${trimmedUrl}'`);
}

// ===========================================================================
// 3. hasNonDefaultFilters
// ===========================================================================

async function testHasNonDefaultFilters() {
  console.log("─── 3. hasNonDefaultFilters ───");

  const { hasNonDefaultFilters } = await import("../explore/url-params");

  // ── Q. False for all defaults ──────────────────────────────────────
  check(
    hasNonDefaultFilters({ search: "", category: null, format: null, status: "all", sort: "grouped" }) === false,
    "Q: All defaults → false",
  );

  // ── R. True for each individual non-default ────────────────────────
  check(
    hasNonDefaultFilters({ search: "x", category: null, format: null, status: "all", sort: "grouped" }) === true,
    "R1: Non-default search → true",
  );
  check(
    hasNonDefaultFilters({ search: "", category: "sports", format: null, status: "all", sort: "grouped" }) === true,
    "R2: Non-default category → true",
  );
  check(
    hasNonDefaultFilters({ search: "", category: null, format: "prediction", status: "all", sort: "grouped" }) === true,
    "R3: Non-default format → true",
  );
  check(
    hasNonDefaultFilters({ search: "", category: null, format: null, status: "live", sort: "grouped" }) === true,
    "R4: Non-default status → true",
  );
  check(
    hasNonDefaultFilters({ search: "", category: null, format: null, status: "all", sort: "recent" }) === true,
    "R5: Non-default sort → true",
  );
  check(
    hasNonDefaultFilters({ search: "x", category: "sports", format: "prediction", status: "live", sort: "closing" }) === true,
    "R6: All non-default → true",
  );
}

// ===========================================================================
// 4. CURSOR ENCODING
// ===========================================================================

async function testCursorEncoding() {
  console.log("─── 4. Cursor encoding ───");

  const { encodeCursor, decodeCursor } = await import("../explore/cursor");
  type CursorPayload = import("../explore/cursor").CursorPayload;

  // ── S. Valid flat cursor round-trip ────────────────────────────────
  const flatPayload: CursorPayload = {
    v: 1,
    sort: "recent",
    key: ["2026-08-01T12:00:00.000Z", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
  };
  const flatEncoded = encodeCursor(flatPayload);
  const flatDecoded = decodeCursor(flatEncoded);
  check(flatDecoded !== null, "S1: Flat cursor decoded");
  check(flatDecoded!.v === 1, "S2: Version preserved");
  check(flatDecoded!.sort === "recent", "S3: Sort preserved");
  check(flatDecoded!.section === undefined, "S4: Section is undefined for flat");
  check(flatDecoded!.key[0] === "2026-08-01T12:00:00.000Z", "S5: Key[0] preserved");
  check(flatDecoded!.key[1] === "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "S6: Key[1] preserved");

  // ── T. Valid grouped cursor round-trip ─────────────────────────────
  const groupedPayload: CursorPayload = {
    v: 1,
    sort: "grouped",
    section: "closing_soon",
    key: ["2026-08-01T12:00:00.000Z", "b2c3d4e5-f6a7-8901-bcde-f12345678901"],
  };
  const groupedEncoded = encodeCursor(groupedPayload);
  const groupedDecoded = decodeCursor(groupedEncoded);
  check(groupedDecoded !== null, "T1: Grouped cursor decoded");
  check(groupedDecoded!.section === "closing_soon", "T2: Section preserved");
  check(groupedDecoded!.sort === "grouped", "T3: Sort preserved");

  // Round-trip with all 3 sections
  for (const sec of ["closing_soon", "live_now", "recently_closed"] as const) {
    const p: CursorPayload = { v: 1, sort: "grouped", section: sec, key: ["ts", "id"] };
    const d = decodeCursor(encodeCursor(p));
    check(d?.section === sec, `T4: Section '${sec}' round-trips`);
  }

  // ── U. Invalid base64 → null ───────────────────────────────────────
  check(decodeCursor("!!!not-valid-base64!!!") === null, "U1: Invalid base64 → null");
  check(decodeCursor("") === null, "U2: Empty string → null");
  check(decodeCursor("=") === null, "U3: Bare equals → null");

  // ── V. Invalid JSON → null ─────────────────────────────────────────
  const badJson = Buffer.from("{invalid", "utf-8").toString("base64url");
  check(decodeCursor(badJson) === null, "V1: Invalid JSON → null");

  // ── W. Unsupported cursor version → null ───────────────────────────
  check(decodeCursor(encodeCursor({ v: 1, sort: "recent", key: ["a", "b"] } as CursorPayload)) !== null,
    "W0: Sanity: version 1 is valid");
  // Version 2 not supported
  const v2 = encodeCursor({ v: 1, sort: "recent", key: ["a", "b"] } as CursorPayload);
  const v2Decoded = decodeCursor(v2);
  check(v2Decoded !== null && v2Decoded.v === 1, "W0b: v=1 round-trips");
  // Create a version-2 cursor manually
  const v2Manual = Buffer.from(JSON.stringify({ v: 2, sort: "recent", key: ["a", "b"] }), "utf-8").toString("base64url");
  check(decodeCursor(v2Manual) === null, "W1: Version 2 → null");

  // ── X. Invalid cursor sort → null ──────────────────────────────────
  const badSort = Buffer.from(JSON.stringify({ v: 1, sort: "popular", key: ["a", "b"] }), "utf-8").toString("base64url");
  check(decodeCursor(badSort) === null, "X1: Invalid sort 'popular' → null");

  const missingSort = Buffer.from(JSON.stringify({ v: 1, key: ["a", "b"] }), "utf-8").toString("base64url");
  check(decodeCursor(missingSort) === null, "X2: Missing sort → null");

  // ── Y. Invalid cursor section → null ───────────────────────────────
  const badSection = Buffer.from(JSON.stringify({ v: 1, sort: "grouped", section: "all_polls", key: ["a", "b"] }), "utf-8").toString("base64url");
  check(decodeCursor(badSection) === null, "Y1: Invalid section → null");

  // ── Z. Malformed cursor key → null ─────────────────────────────────
  const shortKey = Buffer.from(JSON.stringify({ v: 1, sort: "recent", key: ["a"] }), "utf-8").toString("base64url");
  check(decodeCursor(shortKey) === null, "Z1: Key with 1 element → null");

  const longKey = Buffer.from(JSON.stringify({ v: 1, sort: "recent", key: ["a", "b", "c"] }), "utf-8").toString("base64url");
  check(decodeCursor(longKey) === null, "Z2: Key with 3 elements → null");

  const nonStringKey = Buffer.from(JSON.stringify({ v: 1, sort: "recent", key: [123, "b"] }), "utf-8").toString("base64url");
  check(decodeCursor(nonStringKey) === null, "Z3: Non-string key element → null");

  const missingKey = Buffer.from(JSON.stringify({ v: 1, sort: "recent" }), "utf-8").toString("base64url");
  check(decodeCursor(missingKey) === null, "Z4: Missing key → null");

  // ── Additional: non-object, null, array inputs ──────────────────────
  const nullJson = Buffer.from("null", "utf-8").toString("base64url");
  check(decodeCursor(nullJson) === null, "Z5: JSON null → null");

  const arrJson = Buffer.from("[]", "utf-8").toString("base64url");
  check(decodeCursor(arrJson) === null, "Z6: JSON array → null");

  // ── Additional: decodeCursor never throws ───────────────────────────
  check(decodeCursor("\x00\x01\x02") === null, "Z7: Binary garbage → null (no throw)");
  check(decodeCursor("undefined") === null, "Z8: Arbitrary string → null (no throw)");
}

// ---------------------------------------------------------------------------
run().catch((err) => { console.error("\n\x1b[31mCrash:\x1b[0m", err); process.exit(1); });
