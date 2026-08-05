# V2A.7 Server-Driven Explore Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Votum Explore to server-side search, filtering, deterministic
cursor pagination, immediate canonical URL filters, and independent grouped
Load more controls while preserving V2A.5 behaviour.

**Architecture:** A new server query module (`src/lib/data/explore-queries.ts`)
extends the existing `public-polls.ts` pattern (anonymous publishable key,
direct Supabase server-client call from a Server Component) with cursor-based
pagination, server-side filtering via `.ilike()`/`.eq()`/`.order()`, and
section-specific grouped queries. The client controller
(`ExploreClient.tsx`) gains URL synchronisation via `useSearchParams` +
`router.replace`, a 300 ms search debounce, per-section `Load more` buttons, and
stale-request gating.

**Tech Stack:** Next.js 16.2.12, React 19.2.4, TypeScript, Supabase/Postgres,
Tailwind CSS v4, existing `npx tsx` test utilities, `cleanupTestWallet` helper.

---

## Global Constraints

- Only public polls are queried (`is_public = true`).
- Only `live` and `closed` statuses are returned.
- The anonymous publishable key is used for explore queries (no service_role).
- No database migration is required for V2A.7 (existing indexes are sufficient).
- No hosted Supabase changes occur.
- `PollCard` component is never modified.
- Existing V2A.5 grouping and ordering semantics are preserved exactly.
- Cursors are never stored in the shareable URL.
- Only non-default filter values appear in the URL.
- Invalid URL values are dropped silently.
- `next.config.ts` and `.env.local` are not modified or staged.
- Tests use the existing `npx tsx` + admin Supabase client + `cleanupTestWallet` pattern.
- All V2A.2–V2A.6 regression suites must continue to pass.

---

## Settled Technical Decisions

### 1. Canonical Explore filter state type

```ts
// src/lib/explore/types.ts (new)
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import type { ExploreSortMode } from "@/lib/explore/filters";

export interface ExploreFilterState {
  search: string;                     // trimmed, "" = default (no search)
  category: PollCategory | null;      // null = all
  format: PollFormat | null;          // null = all
  status: "all" | "live" | "closed";  // "all" = default
  sort: ExploreSortMode;              // "grouped" = default
}
```

### 2. URL query parameter names

| State field | URL param | Values (non-default only) |
|-------------|-----------|--------------------------|
| `search` | `q` | trimmed string, omitted when `""` |
| `category` | `category` | `sports` / `entertainment` / `brands_products` / `communities` / `other` |
| `format` | `format` | `decision` / `prediction` / `fan_vote` / `ranking` / `nomination` / `audience_choice` |
| `status` | `status` | `live` / `closed` |
| `sort` | `sort` | `recent` / `closing` |

### 3. Default status and sort values

- Default `status`: `"all"` (omitted from URL)
- Default `sort`: `"grouped"` (omitted from URL)
- Default `category`: `null` (omitted from URL)
- Default `format`: `null` (omitted from URL)
- Default `search`: `""` (omitted from URL)

### 4. Server request and response shapes

```ts
// src/lib/data/explore-queries.ts (new)

export interface ExploreQueryParams {
  search: string;
  category: PollCategory | null;
  format: PollFormat | null;
  status: "all" | "live" | "closed";
  sort: ExploreSortMode;
  section?: PollSection;     // only for grouped Load more
  cursor?: string;           // opaque, base64url-encoded JSON
  limit: number;             // clamped [1, 24], default 12 (4 for grouped first)
}

export interface ExploreQueryResult {
  polls: PollCardData[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface GroupedExploreResult {
  closingSoon: ExploreQueryResult;
  liveNow: ExploreQueryResult;
  recentlyClosed: ExploreQueryResult;
}
```

### 5. Flat response shape

`ExploreQueryResult` — used for `recent` and `closing` modes.

### 6. Grouped response shape

`GroupedExploreResult` — used for `grouped` mode. Each section is an
independent `ExploreQueryResult`.

### 7. PollCard-compatible public data shape

```ts
// src/lib/explore/types.ts (new)

export interface PollCardData {
  id: string;
  question: string;
  context?: string;
  category: PollCategory;
  format: PollFormat;
  status: PollStatus;      // stored DB status (client derives effectiveStatus)
  closingAt: string;       // raw ISO string from ends_at
  createdAt: string;       // raw ISO string
  optionCount: number;
}
```

### 8. Cursor payload versioning

Cursors embed a `v: 1` version field for forward compatibility.

```ts
// src/lib/explore/cursor.ts (new)

interface CursorPayload {
  v: 1;
  sort: ExploreSortMode;           // the sort mode this cursor belongs to
  section?: PollSection;           // for grouped mode
  key: [string | number, string];  // ordering values + poll ID
}
```

### 9. Cursor encoding method

Base64url-encoded JSON (`JSON.stringify` → `Buffer.from().toString("base64url")`).

### 10. Cursor validation failure contract

Malformed base64, invalid JSON, missing version, version mismatch, or sort/section
mismatch all cause the query to return the first page of results (same behaviour
as no cursor). No error is returned to the client.

### 11. Precise ordering keys for every mode

| Mode / Section | Primary key | Direction | Tie-breaker |
|---------------|-------------|-----------|-------------|
| `recent` | `created_at` | DESC | `id` ASC |
| `closing` | `ends_at` | ASC | `id` ASC |
| `closing_soon` | `ends_at` | ASC | `id` ASC |
| `live_now` | `created_at` | DESC | `id` ASC |
| `recently_closed` | `ends_at` | DESC | `id` ASC |

### 12. Null/invalid timestamp handling

- `created_at`: Never null (set at poll creation). No special handling needed.
- `ends_at`: Can be null for polls without deadlines. Null `ends_at` polls:
  - In grouped mode: classified as `live_now` (per existing V2A.5 semantics).
  - In `closing` flat mode: excluded entirely (no valid deadline to sort by).
  - In `recent` flat mode: included normally (sorted by `created_at`).

For cursor pagination with `ends_at` as the primary key, nulls are placed last
using `NULLS LAST` in the ORDER BY clause. The cursor comparison treats null
as a sentinel value.

### 13. Search implementation

Supabase `.ilike()` filter on `question` and `description` columns, combined
with `.or()`:

```ts
.or(`question.ilike.%${search}%,description.ilike.%${search}%`)
```

Single-term pattern. Supports partial-word matching out of the box via
PostgREST's `ilike`. No `pg_trgm` extension or full-text search is required for
V2A.7.

### 14. Case sensitivity behaviour

Case-insensitive via `ilike` (PostgreSQL's case-insensitive LIKE).

### 15. Wildcard and special-character handling

Search input is percent-encoded for URL transmission. PostgREST handles SQL
injection internally via parameterized queries. The `%` and `_` characters in
user input are literal within `ilike` (PostgREST escapes them). No additional
sanitization is required beyond trimming.

### 16. Maximum search length

200 characters (matching `MAX_QUESTION_LENGTH` in the publish route). Longer
input is trimmed server-side. The client input has no hard limit but the
server clamps.

### 17. Maximum server limit

Clamped to `[1, 24]`. Default 12 for flat modes, 4 for grouped first load,
12 for grouped Load more.

### 18. Public/private query enforcement

`.eq("is_public", true)` on every query. `.in("status", ["live", "closed"])`
excludes drafts and cancelled polls. The anonymous publishable key is used
(same as current `listPublicPolls`). No service_role.

### 19. Stale-request protection mechanism

A request generation counter (`requestId: number`) is incremented on every
filter change. Each response carries the `requestId` it was dispatched with.
Before applying a response, the client checks the response's `requestId`
against the current active `requestId`. If they differ, the response is
discarded. In-flight fetch requests are also aborted via `AbortController`
where the browser supports it.

### 20. Duplicate-appending prevention

Before appending Load more results, the client filters out any poll IDs
already present in the current `polls` array via a `Set<string>`.

### 21. Loading/error/retry state ownership

All loading, error, and retry state is owned by `ExploreClient`. The server
query module is stateless — it returns data or throws. The client manages:

- `loadingInitial: boolean` — true while the first query is in-flight
- `loadingMore: boolean` (flat) or `loadingMoreBySection: Record<PollSection, boolean>` (grouped)
- `error: string | null` — set on initial load or Load more failure
- Retry: re-fires the same request (same cursor, same filters)

### 22. Test-fixture strategy

Each V2A.7 test suite creates its own polls via `publish_poll_atomic` (same
pattern as V2A.2–V2A.6). Tests use the exact `cleanupTestWallet` helper.
Server-query tests access the query functions directly (imported module, no
HTTP). Client-controller tests use the existing `npx tsx` pattern with admin
Supabase client for fixture setup. URL parsing tests are pure unit tests
(no DB). No test depends on pre-existing records except the 6 QA fixtures.

### 23. Whether an index change is required

**No.** The existing indexes cover all V2A.7 query patterns:

- `idx_polls_public_status_created` covers status + `created_at` DESC (recent mode)
- `idx_polls_public_status_ends` covers status + `ends_at` (closing/closing_soon modes)
- `idx_polls_public_category_status_ends` covers category + status + ends_at
- `idx_polls_public_format_status_created` covers format + status + created_at
- `polls_pkey` (on `id`) covers the tie-breaker

`ilike` search with leading wildcard cannot use a standard B-tree index. If
search performance degrades at scale, a GIN trigram index (`pg_trgm`) on
`(question, description)` can be added in a measured follow-up. V2A.7 does
not add this index.

---

## Task Decomposition

### V2A.7A — Query contracts and canonical URL model

**Files:**

- Create: `src/lib/explore/types.ts` (lines 1–70)
- Create: `src/lib/explore/cursor.ts` (lines 1–90)
- Create: `src/lib/explore/url-params.ts` (lines 1–130)
- Test: `src/lib/api/v2a7a-test.ts` (new, ~200 lines)

**Interfaces:**

- Produces: `ExploreFilterState`, `PollCardData`, `PollSection` (re-export from filters), `ExploreSortMode` (re-export from filters)
- Produces: `encodeCursor(payload: CursorPayload): string`, `decodeCursor(cursor: string): CursorPayload | null`
- Produces: `parseExploreParams(searchParams: URLSearchParams): ExploreFilterState`
- Produces: `buildExploreUrl(state: ExploreFilterState): string`
- Produces: `hasNonDefaultFilters(state: ExploreFilterState): boolean`
- Consumes: `PollCategory`, `PollFormat` from taxonomy; `PollSection`, `ExploreSortMode` from filters

**Checkbox steps:**

- [ ] Write `src/lib/explore/types.ts` with `ExploreFilterState`, `PollCardData`
- [ ] Write `src/lib/explore/cursor.ts` with `CursorPayload`, `encodeCursor`, `decodeCursor`
- [ ] Write test cases for cursor encode/decode round-trip, malformed rejection, version/sort mismatch
- [ ] Run: `npx tsx src/lib/api/v2a7a-test.ts` — cursor tests fail (no URL tests yet)
- [ ] Write `src/lib/explore/url-params.ts` with `parseExploreParams`, `buildExploreUrl`, `hasNonDefaultFilters`
- [ ] Write URL parser test cases: default omission, valid param preservation, invalid value cleanup, one category/format, empty/trimmed search, parameter order stability
- [ ] Run: `npx tsx src/lib/api/v2a7a-test.ts` — all pass
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Commit: `feat(v2a7a): define explore query contracts and URL model`

### V2A.7B — Server query layer and flat pagination

**Files:**

- Create: `src/lib/data/explore-queries.ts` (lines 1–280)
- Test: `src/lib/api/v2a7b-test.ts` (new, ~300 lines)

**Interfaces:**

- Produces: `queryExplorePolls(params: ExploreQueryParams): Promise<ExploreQueryResult>`
- Produces: `queryExploreFlat(params: ExploreQueryParams): Promise<ExploreQueryResult>` (convenience)
- Consumes: `CursorPayload`, `PollCardData`, `ExploreFilterState` from V2A.7A types
- Consumes: Supabase anon client from `@/lib/supabase/config`

**Checkbox steps:**

- [ ] Write `queryExplorePolls` — builds Supabase query with `.eq("is_public", true)`, `.in("status", ...)`, category/format `.eq()`, search `.or(ilike)`, `.order()` chain, `.limit(limit + 1)`
- [ ] Implement cursor continuation: decode cursor, build composite WHERE clause for PostgREST key comparison
- [ ] Implement `hasMore` detection via limit+1 fetch
- [ ] Implement `nextCursor` encoding from last result's ordering fields
- [ ] Handle `recent` sort mode: `created_at DESC, id ASC`
- [ ] Handle `closing` sort mode: `ends_at ASC, id ASC` (live only, valid deadline)
- [ ] Handle malformed cursor → first page (no error)
- [ ] Write test: flat first page of 12, next page of 12, cursor continuation, malformed cursor → first page
- [ ] Write test: category filter, format filter, status filter, search filter (question + context)
- [ ] Write test: no duplicates, no skipped polls, deterministic ordering
- [ ] Write test: private/draft exclusion, public-only boundary
- [ ] Run: `npx tsx src/lib/api/v2a7b-test.ts` — all pass
- [ ] Run V2A.2–V2A.6 suites (unchanged)
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Commit: `feat(v2a7b): implement server query layer with flat pagination`

### V2A.7C — Grouped query and independent cursors

**Files:**

- Modify: `src/lib/data/explore-queries.ts` (add grouped query functions, ~+120 lines)
- Test: `src/lib/api/v2a7c-test.ts` (new, ~250 lines)

**Interfaces:**

- Produces: `queryExploreGrouped(params: ExploreQueryParams): Promise<GroupedExploreResult>`
- Consumes: `GroupedExploreResult`, `ExploreQueryResult` from V2A.7B
- Consumes: `PollSection` from V2A.7A

**Checkbox steps:**

- [ ] Write `queryExploreGrouped` — when `section` is undefined, query all 3 sections independently
- [ ] Implement `closing_soon` sub-query: `status = "live" AND ends_at > now() AND ends_at <= now() + 72h`, ordered by `ends_at ASC, id ASC`, limit 4
- [ ] Implement `live_now` sub-query: `status = "live" AND (ends_at > now() + 72h OR ends_at IS NULL)`, ordered by `created_at DESC, id ASC`, limit 4
- [ ] Implement `recently_closed` sub-query: `status = "closed" OR (status = "live" AND ends_at <= now())`, ordered by `ends_at DESC, id ASC`, limit 4
- [ ] Implement grouped Load more: when `section` is specified, query only that section with limit 12 using the section's cursor
- [ ] Verify each section has an independent cursor
- [ ] Write test: grouped first load returns 4/4/4
- [ ] Write test: each section Load more returns 12 per action
- [ ] Write test: independent cursors — loading closing_soon does not affect live_now
- [ ] Write test: no duplicate polls across sections or across pages
- [ ] Write test: closing_soon classification (≤72h boundary)
- [ ] Write test: recently_closed includes stored-closed and expired-live
- [ ] Write test: live_now includes null-ends_at polls
- [ ] Run: `npx tsx src/lib/api/v2a7c-test.ts` — all pass
- [ ] Run V2A.2–V2A.7B suites
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Commit: `feat(v2a7c): add grouped query with independent section cursors`

### V2A.7D — Explore client URL controller

**Files:**

- Modify: `src/components/explore/ExploreClient.tsx` (lines 1–353, major rewrite)
- Modify: `src/app/explore/page.tsx` (lines 1–43, use explore-queries, pass initial data)
- Test: `src/lib/api/v2a7d-test.ts` (new, ~220 lines)

**Interfaces:**

- Consumes: `ExploreFilterState`, `PollCardData` from V2A.7A
- Consumes: `parseExploreParams`, `buildExploreUrl`, `hasNonDefaultFilters` from url-params
- Consumes: `queryExploreFlat`, `queryExploreGrouped` from explore-queries
- Consumes: `useSearchParams` from next/navigation; `useRouter` from next/navigation
- Produces: modified `ExploreClient` props (now accepts initial `ExploreQueryResult | GroupedExploreResult | null` instead of `PollView[]`)

**Checkbox steps:**

- [ ] Modify `src/app/explore/page.tsx`: read URL search params, call `queryExploreFlat` or `queryExploreGrouped` server-side, pass result to `ExploreClient`
- [ ] Rewrite `ExploreClient` state: replace `useState` filter state with `useSearchParams`-derived filter state
- [ ] Implement URL sync: on filter change, build canonical URL, call `router.replace()`
- [ ] Implement filter-reset: changing any filter resets `polls`, `cursor`, `hasMore`
- [ ] Implement search debounce: 300 ms debounced setter for search query
- [ ] Implement stale-request gating: `requestId` counter, discard mismatched responses
- [ ] Implement duplicate-ID protection: filter appending results against existing IDs
- [ ] Implement Clear filters: shown when `hasNonDefaultFilters` is true, navigates to `/explore`
- [ ] Implement initial data display: render server-provided first batch without a second client fetch
- [ ] Write test: URL restoration on mount (valid params → filters populated)
- [ ] Write test: URL cleanup (invalid params → removed)
- [ ] Write test: filter change → URL replace, data reset
- [ ] Write test: search debounce (300 ms)
- [ ] Write test: stale response discarded (second filter change during in-flight request)
- [ ] Write test: Clear filters visibility and behaviour
- [ ] Run: `npx tsx src/lib/api/v2a7d-test.ts` — all pass
- [ ] Run V2A.2–V2A.7C suites
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Commit: `feat(v2a7d): add explore URL controller and client sync`

### V2A.7E — Load more, loading, retry, and accessibility UI

**Files:**

- Modify: `src/components/explore/ExploreClient.tsx` (add Load more, loading/retry/empty/exhausted states, ~+100 lines)
- Modify: `src/components/explore/ExploreToolbar.tsx` (add `onClearFilters` prop, ~+5 lines)
- Test: `src/lib/api/v2a7e-test.ts` (new, ~180 lines)

**Interfaces:**

- Consumes: `ExploreQueryResult`, `GroupedExploreResult` from explore-queries
- Produces: Load more button per mode (flat → single button; grouped → 3 per-section buttons)
- Produces: Loading spinner, retry link, exhausted message per section
- No new module exports

**Checkbox steps:**

- [ ] Add flat Load more button: disabled during loading, shows spinner, appends results
- [ ] Add grouped per-section Load more buttons: independent disabled/loading/spinner state
- [ ] Implement exhausted state: when `hasMore` is false, show "No more polls in this section" and hide button
- [ ] Implement Load more error: show retry text below last card; do not blank existing cards
- [ ] Implement retry: re-fires the same cursor query
- [ ] Add `aria-busy`, `aria-disabled`, `aria-label="Clear all filters"` attributes
- [ ] Add `role="alert"` on error messages
- [ ] Add `onClearFilters` prop to `ExploreToolbar`; render Clear filters button when non-default
- [ ] Verify keyboard accessibility: rails remain tabbable, focus stays on Load more after append (no focus theft)
- [ ] Verify `prefers-reduced-motion` respected (existing Tailwind utilities)
- [ ] Write test: flat Load more adds 12 cards, button disabled state
- [ ] Write test: grouped per-section Load more adds 12, other sections unchanged
- [ ] Write test: exhausted state hides button
- [ ] Write test: retry re-fires and appends
- [ ] Write test: Clear filters renders with `aria-label` and resets to `/explore`
- [ ] Run: `npx tsx src/lib/api/v2a7e-test.ts` — all pass
- [ ] Run V2A.2–V2A.7D suites
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Commit: `feat(v2a7e): add load more, loading, retry, and accessibility states`

### V2A.7F — Full regression and mobile QA gate

**Files:**

- Test: `src/lib/api/v2a7f-regression.ts` (new, ~150 lines)
- No production code changes (regression-only gate)

**Interfaces:**

- Consumes: all V2A.7 modules
- Consumes: all V2A.2–V2A.6 test suites
- Produces: regression report (pass/fail + totals)

**Checkbox steps:**

- [ ] Write V2A.7F regression test: exercises all V2A.7 query modes, URL parsing, cursor round-trip, search boundary, public/private exclusion, duplicate prevention
- [ ] Run V2A.2 suite — must pass unchanged
- [ ] Run V2A.3 suite — must pass unchanged
- [ ] Run V2A.4 suite — must pass unchanged
- [ ] Run V2A.5 suite — must pass unchanged
- [ ] Run V2A.6A suite — must pass unchanged
- [ ] Run V2A.6B suite — must pass unchanged
- [ ] Run V2A.6C suite — must pass unchanged (73/73)
- [ ] Run V2A.6D suite — must pass unchanged (33/33), confirm ports free after
- [ ] Run V2A.7A–V2A.7E suites — all must pass
- [ ] Run V2A.7F regression — all pass
- [ ] Run complete suite twice — identical totals both runs
- [ ] Verify post-suite: 0 automated polls/options/votes/intents/contributions, 6 QA fixtures
- [ ] Run: `npx tsc --noEmit` — 0 errors
- [ ] Run: `npm run lint` — 0 warnings
- [ ] Run: `npm run build` — success
- [ ] Manual Nimiq Pay QA:
  - [ ] Rails remain usable
  - [ ] Typing feels responsive
  - [ ] URL filters update correctly on filter change
  - [ ] Refresh restores filters from URL
  - [ ] Shared link restores filters
  - [ ] Load more works in flat modes
  - [ ] Each grouped section loads independently
  - [ ] No horizontal page overflow
  - [ ] No hydration warning
  - [ ] No disruptive scroll or focus jump
- [ ] Commit: `feat(v2a7f): finalise regression gate and mobile QA`

---

## Database Indexes — Current State

| Index | Definition | Covers |
|-------|-----------|--------|
| `idx_polls_public_status_created` | `(status, created_at DESC) WHERE is_public = true` | Recent mode, live_now section |
| `idx_polls_public_status_ends` | `(status, ends_at) WHERE is_public = true` | Closing mode, closing_soon, recently_closed |
| `idx_polls_public_category_status_ends` | `(category, status, ends_at) WHERE is_public = true` | Category-filtered grouped queries |
| `idx_polls_public_format_status_created` | `(format, status, created_at DESC) WHERE is_public = true` | Format-filtered recent queries |
| `polls_pkey` | `(id)` | Tie-breaker for all modes |

**Assessment:** Sufficient for V2A.7. No new index required. The `ilike` search
with leading wildcard cannot use B-tree indexes; a GIN trigram index on
`(question, description)` may be useful at scale but is deferred to a
measured follow-up.

---

## Out of Scope (Deferred)

- GIN trigram search index (measured follow-up)
- `pg_trgm` extension installation
- Hosted Supabase migration rollout
- Production deployment
- Merging into main
- Multi-category or multi-format selection
- Infinite scrolling
- Cursor persistence in URLs
- Recommendation or popularity ranking
- Voting or NIM-support changes
