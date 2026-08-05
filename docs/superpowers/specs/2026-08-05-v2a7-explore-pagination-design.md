# V2A.7 — Server-Driven Explore Filtering and Pagination

**Status:** Approved  
**Date:** 2026-08-05  
**Branch:** `feat/v2-participation-record`  
**Depends on:** V2A.5 (Structured Explore), V2A.6 (Contract Verification)

---

## Purpose

Move Explore from loading and filtering the full poll collection in the
browser to a scalable server-owned query model.

V2A.7 must preserve the existing V2A.5 Explore experience while adding:

- server-side filtering;
- server-side search;
- cursor-based pagination;
- immediate shareable URL filters;
- independent pagination for grouped sections;
- deterministic ordering;
- stale-request protection;
- safe handling of invalid URLs.

---

## Current Architecture (V2A.5)

### Data flow

```
page.tsx (Server Component)
  └─ listPublicPolls()          ← fetches ALL public polls (no limit)
       └─ supabase.from("polls") .in("status", ["live","closed"]) .eq("is_public", true)
  └─ passes full PollView[] to ExploreClient

ExploreClient ("use client")
  └─ useMemo → filterAndSortResults(polls, filters)   ← 100% client-side
       └─ filterAndGroupPolls() → classifyPollSection() → sort
  └─ renders all results directly (no pagination)
```

### Key files

| File | Role |
|------|------|
| `src/app/explore/page.tsx` | Server Component, calls `listPublicPolls` |
| `src/app/explore/layout.tsx` | Metadata only |
| `src/lib/data/public-polls.ts` | Supabase query layer (anon key) |
| `src/lib/explore/filters.ts` | Client-side filtering, sorting, classification |
| `src/components/explore/ExploreClient.tsx` | Client state, rendering |
| `src/components/explore/ExploreToolbar.tsx` | Search, status, sort controls |
| `src/components/product/PollCard.tsx` | Card component |

### What exists

- **Status filters:** All polls / Live / Closed
- **Sort modes:** Grouped by status / Recently created / Closing first
- **Category filter rail:** 5 categories + "All"
- **Format filter rail:** 6 formats + "All"
- **Text search:** Case-insensitive substring match on question + context (no debounce)
- **Group sections:** Closing soon (≤72h), Live now, Recently closed
- **Section sorting:** Deterministic with poll ID tie-breaker
- **PollCard rendering:** Question, taxonomy badges, option count, effective status badge, closing date

### What does not exist

- **No pagination** of any kind — full result set loads on every page visit
- **No server-side filtering** — all filtering happens in browser memory
- **No URL state** — filters are not stored in query parameters; refresh resets everything
- **No debounce** on search input — every keystroke triggers a re-render on the full array
- **No cursor logic** — no concept of continuing from a boundary

---

## Product Decisions (Final)

- Pagination uses **Load more**, not numbered pages.
- Flat result modes load **12 polls per batch**.
- Grouped first load returns **4 Closing soon + 4 Live now + 4 Recently closed** (12 total).
- Each grouped section loads **12 additional polls** per Load more action.
- Filters update **immediately** (no separate Apply button).
- Search uses a **300 ms debounce**.
- URL navigation uses **replace** behaviour (only latest filtered URL remains in history).
- Users select **one category** at a time.
- Users select **one format** at a time.
- Cursor-based pagination is used internally; **cursors are not stored in the shareable URL**.
- Search covers poll **question** and **context**; excludes wallet addresses and internal IDs.
- Only **non-default values** appear in the URL.
- Invalid URL values are **ignored and removed safely**; valid values are preserved.
- **Clear filters** appears whenever state differs from default; returns page to `/explore`.
- Each grouped section has a **separate** Load more control with independent state.

---

## Canonical URL Model

### Default page

```
/explore
```

### Parameter names

| Parameter | Values | Default (omitted) |
|-----------|--------|-------------------|
| `q` | any string (trimmed) | `""` |
| `category` | `sports` / `entertainment` / `brands_products` / `communities` / `other` | omitted |
| `format` | `decision` / `prediction` / `fan_vote` / `ranking` / `nomination` / `audience_choice` | omitted |
| `status` | `live` / `closed` | omitted (`"all"`) |
| `sort` | `grouped` / `recent` / `closing` | omitted (`"grouped"`) |

### Examples

```
/explore
/explore?category=sports
/explore?category=sports&format=prediction
/explore?category=sports&format=prediction&status=live
/explore?q=who+will+win
/explore?sort=recent
/explore?status=closed&sort=closing
```

### Rules

- Only non-default values appear in the URL.
- Internal cursors, section cursors, loaded-page count, and load-more state are never in the URL.
- The URL update uses `router.replace()` — no history accumulation on filter changes.
- Invalid parameter values are dropped from the URL without error.
- Valid parameters are preserved in the canonical order: `q`, `category`, `format`, `status`, `sort`.

---

## Server Query Layer

### Design choice

The existing pattern in `src/lib/data/public-polls.ts` uses a direct Supabase
server-client call from the page Server Component (no API route, no RPC).
V2A.7 extends this pattern: a server query module that accepts validated
parameters and returns paginated, filtered results.

**Rationale:** This is the smallest change that preserves the existing
architecture. An API route would add an unnecessary network hop for a
server→Supabase call that already happens server-side. A Postgres RPC would
couple filtering logic to the database schema in ways that are harder to test
and iterate.

### Module location

```
src/lib/data/explore-queries.ts
```

### Input parameters

```ts
interface ExploreQueryParams {
  search: string;              // trimmed, "" = no filter
  category: PollCategory | null;   // null = all
  format: PollFormat | null;       // null = all
  status: "all" | "live" | "closed";
  sort: ExploreSortMode;
  section?: PollSection;       // only for grouped mode Load more
  cursor?: string;             // opaque, server-validated
  limit: number;               // clamped to [1, 24], default 12 (4 for grouped first)
}
```

All parameters are server-validated. Unknown values fall back to defaults
(`"all"` for status, `"grouped"` for sort, `null` for category/format).

### Cursor format

Cursors are base64url-encoded JSON objects containing the ordering fields
needed to continue pagination deterministically.

| Sort mode | Cursor fields |
|-----------|--------------|
| `recent` | `created_at`, `id` |
| `closing` | `ends_at`, `id` |
| `grouped` / `closing_soon` | `ends_at`, `id` |
| `grouped` / `live_now` | `created_at`, `id` |
| `grouped` / `recently_closed` | `ends_at`, `id` |

The `id` field is always the final tie-breaker.

Malformed, expired, or incompatible cursors cause the query to return the
first page with `nextCursor: null`. No error is surfaced to the client for
bad cursors — the behaviour is identical to an unknown/expired cursor.

### Query building

The module constructs a Supabase query against the `polls` table:

```ts
supabase
  .from("polls")
  .select("id, question, description, mode, destination_wallet, destination_purpose, min_nim_luna, fairness_mode, status, starts_at, ends_at, is_public, created_at, category, format")
  .eq("is_public", true)
  .in("status", liveAndClosed)     // depending on status filter
  .order(column, direction)        // depending on sort mode
  .limit(limit + 1)                // fetch one extra to determine hasMore
```

Category and format filters are applied as `.eq()` when not `null`.

Search is applied as a Supabase `ilike` or `or` filter on `question` and
`description` columns. Supabase's PostgREST text filtering is used:
`.ilike("question", `%${search}%`)` and `.or(`description.ilike.%${search}%`)`.

Cursor-based pagination uses the cursor fields with the appropriate comparison
operator (`<` for descending, `>` for ascending).

The options for returned polls are fetched in a follow-up batch query, exactly
as `listPublicPolls` does today.

### Return type

```ts
interface ExploreQueryResult {
  polls: PollCardData[];       // normalized for PollCard rendering
  nextCursor: string | null;   // opaque, null = no more pages
  hasMore: boolean;
}

interface GroupedExploreResult {
  closingSoon: ExploreQueryResult;
  liveNow: ExploreQueryResult;
  recentlyClosed: ExploreQueryResult;
}
```

The server returns either a flat `ExploreQueryResult` (for `recent` and
`closing` modes) or a `GroupedExploreResult` (for `grouped` mode).

### Grouped mode first load

When sort is `grouped` and no section cursor is provided, the server returns
all three sections simultaneously. Each section is an independent sub-query
with its own ordering, limit of 4, and cursor.

### Grouped mode Load more

When sort is `grouped` and a section is specified with its cursor, only that
section is queried with a limit of 12.

### PollCard data shape

The `PollCardData` type is a subset of `PollView` containing only the fields
needed by `PollCard`:

```ts
interface PollCardData {
  id: string;
  question: string;
  context?: string;
  category: PollCategory;
  format: PollFormat;
  status: PollStatus;
  closingAt: string;
  createdAt: string;
  optionCount: number;         // derived from options.length (PollCard only needs the count)
}
```

This avoids sending full `PollOptionView[]`, `destinationWallet`,
`destinationPurpose`, `contributionMode`, and other non-display fields to the
client. The server still fetches options to compute `optionCount`; the array is
not sent to the client.

### Safety guarantees

- Only public polls are queried (`is_public = true`).
- Only `live` and `closed` statuses are queried (no drafts, no cancelled).
- Legacy taxonomy values are normalized via `normalizeCategory` and `normalizeFormat`.
- The anonymous publishable key is used (same as current `listPublicPolls`).
- No service_role is used for explore queries.
- RLS expectations are preserved (public polls policy remains the gate).

---

## Client Controller (`ExploreClient`)

### State management

The controller manages these state groups:

**Filter state (synced to URL):**
- `searchQuery: string`
- `categoryFilter: CategoryFilter`
- `formatFilter: FormatFilter`
- `statusFilter: "all" | "live" | "closed"`
- `sortMode: ExploreSortMode`

**Data state:**
- For flat modes: `polls: PollCardData[]`, `cursor: string | null`, `hasMore: boolean`
- For grouped mode: three independent `{ polls, cursor, hasMore }` objects

**Request state:**
- `loadingInitial: boolean`
- For flat: `loadingMore: boolean`, `error: string | null`
- For grouped: per-section `loadingMore`, `error`

**Request tracking:**
- A request token (incrementing counter or AbortController) to reject stale responses

### URL synchronisation

On filter change:
1. Build the canonical URL from current filter state (omit defaults).
2. Call `router.replace(canonicalUrl)`.
3. Reset all data state (polls = [], cursor = null).
4. Fire the initial query.

On initial mount:
1. Parse URL search params into filter state.
2. Fire the initial query with those filters.

### Search debounce

The search input fires a 300 ms debounced callback. The debounce timer resets
on each keystroke. Only the final value after 300 ms of inactivity triggers a
filter change. This is purely client-side behaviour — the server query layer
has no debounce logic.

### Loading states

| State | Behaviour |
|-------|-----------|
| Initial loading | Show `<LoadingState variant="list" count={3} />` (preserves hero/toolbar layout) |
| Load more (flat) | Disable button, show spinner on button, preserve existing cards |
| Load more (grouped section) | Disable that section's button, show spinner, preserve other sections |
| Stale response | Discard silently; do not mutate current state |

### Error states

| State | Behaviour |
|-------|-----------|
| Initial load fails | Show `<ErrorState>` with retry button (existing pattern) |
| Load more fails (flat) | Show retry text below the last card; do not blank existing cards |
| Load more fails (grouped section) | Show retry text in that section; do not affect other sections |

### Empty states

| State | Behaviour |
|-------|-----------|
| No filters, no polls | Show existing `<EmptyState>` |
| Filters applied, no results | Show contextual "No polls match your filters" message with Clear filters link |
| Section exhausted (grouped) | Show "No more polls in this section" text; hide Load more button |

### Duplicate protection

Before appending Load more results, filter out any poll IDs already present in
the current display list. This guards against cursor boundary edge cases and
data changes between requests.

---

## Filter and Sort Behaviour

### Existing V2A.5 semantics (preserved exactly)

| Concept | Behaviour |
|---------|-----------|
| Closing soon | Live polls where `ends_at` ≤ now + 72 hours |
| Live now | Live polls where `ends_at` > now + 72 hours (or missing/invalid `ends_at`) |
| Recently closed | Stored status = "closed", OR stored status = "live" with `ends_at` ≤ now |
| Closing soon sort | `ends_at` ASC, `id` ASC (earliest closing first) |
| Live now sort | `created_at` DESC, `id` ASC (newest first) |
| Recently closed sort | `ends_at` DESC, `id` ASC (most recently closed first) |
| Recent sort | `created_at` DESC, `id` ASC (flat, all sections merged) |
| Closing sort | `ends_at` ASC, `id` ASC (flat, live polls only, no 72h bound) |
| Invalid/null dates | Sort last within their group; ties broken by `id` ASC |

These are now implemented server-side via Supabase `.order()` chains.
Classification (`closing_soon` / `live_now` / `recently_closed`) is applied in
the query builder via WHERE clauses on `ends_at` and `status`.

### What moves from client to server

| Operation | V2A.5 (client) | V2A.7 (server) |
|-----------|---------------|----------------|
| Text search | `matchesSearch()` on array | `.ilike()` on question + description |
| Category filter | `matchesCategory()` on array | `.eq("category", value)` on query |
| Format filter | `matchesFormat()` on array | `.eq("format", value)` on query |
| Status filter | `matchesStatus()` on array | `.in("status", [...])` on query |
| Section classification | `classifyPollSection()` on array | WHERE clause on `ends_at` + `status` |
| Sorting | `Array.sort()` | `.order(column, { ascending })` chain |
| Limit | None | `.limit(N)` |
| Cursor | None | WHERE composite key comparison |

### What stays on the client

- `effectiveStatus` enrichment (for PollCard rendering — derived from `status` + `closingAt` + `nowMs`)
- `parseTimestamp()` for display formatting
- Section classification for grouped mode rendering (sections are pre-classified by the server)
- Debounce logic

---

## Component Changes

### Files to create

| File | Purpose |
|------|---------|
| `src/lib/data/explore-queries.ts` | Server query layer (params → Supabase queries) |
| `src/lib/explore/url-params.ts` | URL parser, canonical URL builder, default detection |
| `src/lib/explore/cursor.ts` | Cursor encode/decode/validate utilities |
| `src/lib/explore/types.ts` | Shared types for V2A.7 (if not already in taxonomy/filters) |

### Files to modify

| File | Change |
|------|--------|
| `src/app/explore/page.tsx` | Use `explore-queries` instead of `listPublicPolls`; pass initial results from server |
| `src/components/explore/ExploreClient.tsx` | Add URL sync, pagination state, debounce, Load more, Clear filters |
| `src/components/explore/ExploreToolbar.tsx` | Accept `onClearFilters` prop; no structural change needed |
| `src/lib/data/public-polls.ts` | No change (kept for poll detail page and other consumers) |

### Files NOT modified

- `src/components/product/PollCard.tsx` — unchanged (receives same props)
- `src/lib/explore/filters.ts` — kept for client-side helpers (effectiveStatus, parseTimestamp)
- `src/lib/polls/taxonomy.ts` — unchanged

---

## Accessibility

| Requirement | Implementation |
|-------------|---------------|
| Filter controls retain clear selected states | Existing pill styling; `aria-pressed` on status buttons |
| Load more exposes loading and disabled states | `aria-busy`, `aria-disabled`, visible spinner |
| Search remains labelled | Existing `aria-label` on search input |
| Dynamically appended content does not steal focus | Cards append below without `autofocus`; focus stays on Load more button after click |
| Errors are announced appropriately | `role="alert"` on error messages |
| Horizontal rails remain keyboard accessible | Existing tab behaviour (category/format rails use scrollable flex) |
| Clear filters has an explicit accessible name | `aria-label="Clear all filters"` |
| Reduced-motion behaviour | Respects `prefers-reduced-motion` (existing Tailwind `motion-reduce:` utilities) |

---

## Stale-Request Protection

Each filter-change cycle increments a request token. Before applying a
response:

1. Check the response's token against the current active token.
2. If they differ, discard the response (a newer filter is active).
3. If they match, apply the response.

This prevents:
- A slow search query from overwriting results from a newer category change.
- A Load more from a previous filter state appending to current results.

AbortControllers are also used to cancel in-flight fetch requests when
possible.

---

## Data Safety

| Concern | Mitigation |
|---------|-----------|
| Public data only | `.eq("is_public", true)` in all queries |
| No private fields | `PollCardData` excludes `destinationWallet`, `destinationPurpose`, `contributionMode` |
| RLS preservation | Anonymous publishable key; RLS policy `polls_public_read` remains active |
| Draft exclusion | `.in("status", ["live", "closed"])` — drafts never appear |
| Legacy taxonomy | `normalizeCategory()` / `normalizeFormat()` at the query-boundary |
| No service_role | Same anon-key access pattern as current `listPublicPolls` |

---

## Testing Requirements

### V2A.7 automated coverage

**URL parser:**
- Default parameter omission
- Canonical URL cleanup (remove invalid params)
- Preservation of valid parameters
- Invalid category → dropped
- Invalid format → dropped
- Invalid status → dropped
- Invalid sort → dropped
- Empty and trimmed search → omitted
- One category at a time
- One format at a time
- Parameter order stability

**Server query layer:**
- Private and draft exclusion
- Server-side question search
- Server-side context search
- Wallet and ID exclusion from search
- Category filter: exact match
- Format filter: exact match
- Status filter: live/closed/all
- Flat first batch of 12
- Flat next batch of 12
- Grouped first load of 4/4/4
- Independent grouped cursors
- Grouped next batch of 12 per section
- Deterministic cursor boundaries
- No duplicates across pages
- No skipped polls
- Cursor validation (malformed → first page)
- Cursor compatibility (wrong sort → first page)

**Client controller:**
- Filter-reset behaviour (changing filter resets data + cursor)
- 300 ms search debounce
- Replace-style navigation
- Stale-response rejection
- Loading states (initial, load more, per-section)
- Empty states (no polls, no filter matches)
- Failure states (initial error, load more error)
- Retry behaviour
- Exhausted state (hasMore = false)
- Clear filters (visible when non-default, resets to /explore)

**Regression:**
- All existing V2A.2 through V2A.6 suites must pass unchanged.

### Manual Nimiq Pay QA

- Rails remain usable
- Typing feels responsive (debounce is imperceptible in practice)
- URL filters update correctly
- Refresh restores filters
- Shared links restore filters
- Load more works in flat modes
- Each grouped section loads independently
- No horizontal page overflow
- No hydration warning
- No disruptive scroll or focus jump

---

## Out of Scope

V2A.7 does not include:

- Hosted Supabase migration rollout
- Merging into main
- Production deployment
- Recommendation algorithms
- Popularity ranking
- Personalized feeds
- Multi-category selection
- Multi-format selection
- Infinite automatic scrolling
- Cursor persistence in the URL
- Changes to voting
- Changes to NIM support
- Changes to creator analytics
- Visual redesign of Explore

---

## Rollout Plan

1. Implement `src/lib/explore/cursor.ts` (cursor encode/decode/validate)
2. Implement `src/lib/explore/url-params.ts` (URL parser + canonical builder)
3. Implement `src/lib/data/explore-queries.ts` (server query layer)
4. Modify `ExploreClient` (URL sync, pagination, debounce, Load more, Clear filters)
5. Modify `ExploreToolbar` (Clear filters prop)
6. Modify `src/app/explore/page.tsx` (use new query layer, pass initial results)
7. Write V2A.7 automated tests
8. Run all V2A.2–V2A.7 suites
9. Typecheck, lint, build
10. Manual Nimiq Pay QA
11. Commit (feature branch only)

No hosted Supabase changes throughout.

---

## Completion Criteria

V2A.7 is complete when:

- Explore filtering and searching are executed server-side
- URLs are canonical and shareable
- Controls update immediately
- Search is debounced by 300 ms
- Flat modes paginate 12 at a time
- Grouped mode begins at 4/4/4
- Grouped sections paginate independently by 12
- Cursor ordering is deterministic
- Stale responses cannot corrupt the current view
- Public/private boundaries remain intact
- Tests pass (V2A.2–V2A.7)
- Typecheck passes
- Lint has zero errors and warnings
- Production build succeeds
- Mobile Nimiq Pay QA passes
- No hosted Supabase changes occur
