/**
 * V2A.7B/V2A.7C — Server-Side Explore Query Layer
 *
 * Provides cursor-based paginated queries for the Explore page.
 * Uses the anonymous publishable key (no service_role).
 *
 * Flat modes (recent / closing):   V2A.7B
 * Grouped mode (sections):         V2A.7C
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { PollStatus } from "@/types/poll";
import { normalizeCategory, normalizeFormat } from "@/lib/polls/taxonomy";
import { encodeCursor, decodeCursor } from "@/lib/explore/cursor";
import type { CursorPayload } from "@/lib/explore/cursor";
import type {
  ExploreQueryParams,
  ExploreQueryResult,
  GroupedExploreResult,
  PollCardData,
} from "@/lib/explore/types";
import type { PollSection } from "@/lib/explore/filters";
import { CLOSING_SOON_MS } from "@/lib/explore/filters";

// ── Configuration ─────────────────────────────────────────────────────

const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function createAnonClient() {
  if (!url || !key) return null;
  return createClient<Database>(url, key, { db: { schema: "public" } });
}

// ── Column select list (same as listPublicPolls) ──────────────────────

const POLL_COLUMNS =
  "id, question, description, mode, destination_wallet, destination_purpose, min_nim_luna, fairness_mode, status, starts_at, ends_at, is_public, created_at, category, format";

type PollRow = Database["public"]["Tables"]["polls"]["Row"];

// ── Map to PollCardData ───────────────────────────────────────────────

function mapToPollCardData(row: PollRow, optionCount: number): PollCardData {
  return {
    id: row.id,
    question: row.question,
    context: row.description ?? undefined,
    category: normalizeCategory(row.category),
    format: normalizeFormat(row.format),
    status: row.status as PollStatus,
    closingAt: row.ends_at ?? "",
    createdAt: row.created_at,
    optionCount,
  };
}

/** Fetch option counts for a batch of poll IDs. */
async function fetchOptionCounts(
  supabase: ReturnType<typeof createAnonClient>,
  pollIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (pollIds.length === 0) return map;

  const { data, error } = await supabase!
    .from("poll_options")
    .select("poll_id")
    .in("poll_id", pollIds);

  if (error) throw error;

  for (const opt of data ?? []) {
    map.set(opt.poll_id, (map.get(opt.poll_id) ?? 0) + 1);
  }
  // Ensure every poll has at least 0
  for (const id of pollIds) {
    if (!map.has(id)) map.set(id, 0);
  }
  return map;
}

// ── Search literal-escaping ──────────────────────────────────────────
//
// PostgreSQL LIKE wildcards (% and _) are escaped with backslash so
// they match literally.  The LIKE pattern (with surrounding %
// wildcards for substring match) is wrapped in PostgREST single-quote
// syntax so that `or()` filter grammar characters (, ( )) inside the
// value are treated as literal string content.
//
// Apostrophes in user input are handled by PostgreSQL's '' escape
// (doubled single quote).

const MAX_SEARCH_LENGTH = 200;

function escapeLikeLiteral(value: string): string {
  // Order: escape backslash first so we don't re-escape added backslashes,
  // then escape LIKE wildcards for literal match.
  return value
    .replace(/\\/g, "\\\\")   // \  → \\
    .replace(/%/g, "\\%")     // %  → \%  (LIKE wildcard → literal)
    .replace(/_/g, "\\_");    // _  → \_  (LIKE wildcard → literal)
}

/**
 * Build a PostgREST `or` filter clause for case-insensitive substring
 * search across question and description.
 *
 * Values containing PostgREST `or()` grammar characters (, ( )) are
 * wrapped in double-quotes.  Simple values are embedded directly.
 *
 * Returns null when search is empty.
 */
function buildSearchClause(search: string): string | null {
  const trimmed = search.trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;

  const literal = escapeLikeLiteral(trimmed);
  const needsQuoting = /[,(]/.test(literal);
  const pattern = needsQuoting
    ? `"%${literal}%"`
    : `%${literal}%`;

  return `or(question.ilike.${pattern},description.ilike.${pattern})`;
}
//
// V2A.5 semantics:
//   "live"   → stored status = "live" AND (ends_at > now() OR ends_at IS NULL)
//   "closed" → stored status = "closed" OR (stored status = "live" AND ends_at <= now())
//
// The base query always filters `status IN ('live','closed')`.
// The effective-status refinement is expressed as an OR filter.

function statusOrClause(status: "all" | "live" | "closed"): string | null {
  if (status === "live") {
    // live AND (ends_at > now() OR ends_at IS NULL)
    return "or(ends_at.gt.now(),ends_at.is.null)";
  }
  if (status === "closed") {
    // closed OR (live AND expired)
    return "or(status.eq.closed,and(status.eq.live,ends_at.lte.now()))";
  }
  return null; // "all" — no additional filter
}

// ── Cursor WHERE clause builder ────────────────────────────────────────
//
// PostgREST supports only one `or` query parameter per request, so search
// and cursor filters are combined into a single logical expression.
//
// For DESC order (recent), OP is "lt" (less than: newer items come first,
// cursor marks the oldest item on the current page).
// For ASC  order (closing), OP is "gt" (greater than: later items come
// last, cursor marks the latest item on the current page).

function buildCursorClause(cursor: CursorPayload): string | null {
  if (!cursor.key || cursor.key.length !== 2) return null;
  const [colValue, idValue] = cursor.key;

  if (cursor.sort === "recent") {
    // created_at < cursor.created_at  OR  (created_at = cursor.created_at AND id > cursor.id)
    return `or(created_at.lt.${colValue},and(created_at.eq.${colValue},id.gt.${idValue}))`;
  }

  if (cursor.sort === "closing") {
    // ends_at > cursor.ends_at  OR  (ends_at = cursor.ends_at AND id > cursor.id)
    return `or(ends_at.gt.${colValue},and(ends_at.eq.${colValue},id.gt.${idValue}))`;
  }

  return null;
}

/**
 * Build a single PostgREST `or` filter string combining search and cursor
 * conditions.  Returns null when neither is active.
 */
function buildCombinedOrFilter(
  search: string,
  cursor: CursorPayload | null,
  sort: string,
  status: "all" | "live" | "closed",
): string | null {
  const parts: string[] = [];

  // Status filter (effective-status, V2A.5 semantics)
  const statusClause = statusOrClause(status);
  if (statusClause) parts.push(statusClause);

  // Search filter
  if (search) {
    const clause = buildSearchClause(search);
    if (clause) parts.push(clause);
  }

  // Cursor filter
  if (cursor && cursor.sort === sort) {
    const clause = buildCursorClause(cursor);
    if (clause) parts.push(clause);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  // AND all OR groups: and(group1, group2, ...)
  return `and(${parts.join(",")})`;
}

// ── Main query function ────────────────────────────────────────────────

export async function queryExploreFlat(
  params: ExploreQueryParams,
): Promise<ExploreQueryResult> {
  const supabase = createAnonClient();
  if (!supabase) {
    return { polls: [], nextCursor: null, hasMore: false };
  }

  // Normalize
  const limit = Math.max(1, Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT));
  const search = (params.search ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  const status = params.status ?? "all";
  const sort = params.sort ?? "grouped";

  try {
    // Base query: always include live+closed (effective-status refinement via OR filter)
    let query = supabase
      .from("polls")
      .select(POLL_COLUMNS)
      .eq("is_public", true)
      .in("status", ["live", "closed"]);

    // Category filter
    if (params.category) {
      query = query.eq("category", params.category);
    }

    // Format filter
    if (params.format) {
      query = query.eq("format", params.format);
    }

    // Build the combined OR filter (status + search + cursor)
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const combinedOr = buildCombinedOrFilter(search, cursor, sort, status);

    // Mode-specific ordering and limits
    if (sort === "closing") {
      // Closing first: live polls only, valid future deadlines
      query = query.eq("status", "live")
        .not("ends_at", "is", null)
        .gt("ends_at", new Date().toISOString());

      query = query
        .order("ends_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit + 1);
    } else {
      // Recent: all statuses, sorted by created_at DESC
      query = query
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(limit + 1);
    }

    // Apply combined search + cursor OR filter (if any)
    // .or() is available on the raw PostgREST client but the generated Database
    // type does not include it; the cast is intentional and safe.
    if (combinedOr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (query as any) = (query as any).or(combinedOr);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error } = await (query as any);
    if (error) throw error;

    const polls = (rows ?? []) as PollRow[];
    const hasMore = polls.length > limit;
    const resultPolls = polls.slice(0, limit);

    // Fetch option counts
    const pollIds = resultPolls.map((p) => p.id);
    const optionCounts = await fetchOptionCounts(supabase, pollIds);

    // Map to PollCardData
    const cards: PollCardData[] = resultPolls.map((row) =>
      mapToPollCardData(row, optionCounts.get(row.id) ?? 0),
    );

    // Build nextCursor
    let nextCursor: string | null = null;
    if (hasMore && resultPolls.length > 0) {
      const last = resultPolls[resultPolls.length - 1];
      let keyValue: string;
      if (sort === "closing") {
        keyValue = last.ends_at ?? "";
      } else {
        keyValue = last.created_at;
      }
      const payload: CursorPayload = {
        v: 1,
        sort: sort === "closing" ? "closing" : "recent",
        key: [keyValue, last.id],
      };
      nextCursor = encodeCursor(payload);
    }

    return { polls: cards, nextCursor, hasMore };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown query error";
    throw new Error(`Explore query failed: ${message}`);
  }
}

// ===========================================================================
// V2A.7C — Grouped query (closing_soon / live_now / recently_closed)
// ===========================================================================

const GROUP_FIRST_LIMIT = 4;
const GROUP_MORE_LIMIT = 12;

/**
 * Build the section-specific PostgREST conditions.
 * Each section starts from `status IN ('live','closed') AND is_public = true`
 * and narrows via additional WHERE clauses.
 */
function buildSectionBase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  section: PollSection,
  now: Date,
) {
  const nowIso = now.toISOString();
  const boundaryIso = new Date(now.getTime() + CLOSING_SOON_MS).toISOString();

  if (section === "closing_soon") {
    // effectively live AND ends_at IS NOT NULL AND ends_at > now AND ends_at <= now + 72h
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any)
      .eq("status", "live")
      .not("ends_at", "is", null)
      .gt("ends_at", nowIso)
      .lte("ends_at", boundaryIso)
      .order("ends_at", { ascending: true })
      .order("id", { ascending: true });
  } else if (section === "live_now") {
    // effectively live AND (ends_at > now + 72h OR ends_at IS NULL)
    // The OR condition goes into the combined or filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any)
      .eq("status", "live")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });
  } else {
    // recently_closed: status = "closed" OR (status = "live" AND ends_at <= now)
    // The OR condition goes into the combined or filter.
    // Sorting: ends_at DESC, id ASC
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any)
      .order("ends_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });
  }

  return query;
}

function sectionOrClause(section: PollSection, now: Date): string | null {
  const boundaryIso = new Date(now.getTime() + CLOSING_SOON_MS).toISOString();
  const nowIso = now.toISOString();

  if (section === "live_now") {
    return `or(ends_at.gt.${boundaryIso},ends_at.is.null)`;
  }
  if (section === "recently_closed") {
    return `or(status.eq.closed,and(status.eq.live,ends_at.lte.${nowIso}))`;
  }
  // closing_soon: all conditions are simple filters (no OR needed)
  return null;
}

function buildSectionCursorClause(cursor: CursorPayload, section: PollSection): string | null {
  if (!cursor.key || cursor.key.length !== 2) return null;
  const [colValue, idValue] = cursor.key;

  if (section === "closing_soon") {
    // ends_at ASC, id ASC
    return `or(ends_at.gt.${colValue},and(ends_at.eq.${colValue},id.gt.${idValue}))`;
  }
  if (section === "live_now") {
    // created_at DESC, id ASC
    return `or(created_at.lt.${colValue},and(created_at.eq.${colValue},id.gt.${idValue}))`;
  }
  // recently_closed: ends_at DESC, id ASC
  return `or(ends_at.lt.${colValue},and(ends_at.eq.${colValue},id.gt.${idValue}))`;
}

function buildSectionOrFilter(
  section: PollSection,
  search: string,
  cursor: CursorPayload | null,
  now: Date,
): string | null {
  const parts: string[] = [];

  // Section-specific clause
  const secClause = sectionOrClause(section, now);
  if (secClause) parts.push(secClause);

  // Search
  if (search) {
    const sc = buildSearchClause(search);
    if (sc) parts.push(sc);
  }

  // Cursor (must match section)
  if (cursor && cursor.sort === "grouped" && cursor.section === section) {
    const cc = buildSectionCursorClause(cursor, section);
    if (cc) parts.push(cc);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `and(${parts.join(",")})`;
}

async function querySection(
  supabase: ReturnType<typeof createAnonClient>,
  params: ExploreQueryParams,
  section: PollSection,
  now: Date,
  limit: number,
): Promise<ExploreQueryResult> {
  const search = (params.search ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  const status = params.status ?? "all";

  // Status gating: return empty result when section is incompatible
  if (status === "live" && section === "recently_closed") {
    return { polls: [], nextCursor: null, hasMore: false };
  }
  if (status === "closed" && section !== "recently_closed") {
    return { polls: [], nextCursor: null, hasMore: false };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = (supabase as any)
      .from("polls")
      .select(POLL_COLUMNS)
      .eq("is_public", true)
      .in("status", ["live", "closed"]);

    if (params.category) query = query.eq("category", params.category);
    if (params.format) query = query.eq("format", params.format);

    query = buildSectionBase(query, section, now);
    query = query.limit(limit + 1);

    const orFilter = buildSectionOrFilter(section, search, cursor, now);
    if (orFilter) {
      query = query.or(orFilter);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const polls = (rows ?? []) as PollRow[];
    const hasMore = polls.length > limit;
    const resultPolls = polls.slice(0, limit);

    const pollIds = resultPolls.map((p) => p.id);
    const optionCounts = await fetchOptionCounts(supabase, pollIds);

    const cards: PollCardData[] = resultPolls.map((row) =>
      mapToPollCardData(row, optionCounts.get(row.id) ?? 0),
    );

    let nextCursor: string | null = null;
    if (hasMore && resultPolls.length > 0) {
      const last = resultPolls[resultPolls.length - 1];
      let keyValue: string;
      if (section === "live_now") {
        keyValue = last.created_at;
      } else {
        keyValue = last.ends_at ?? "";
      }
      const payload: CursorPayload = {
        v: 1,
        sort: "grouped",
        section,
        key: [keyValue, last.id],
      };
      nextCursor = encodeCursor(payload);
    }

    return { polls: cards, nextCursor, hasMore };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown query error";
    throw new Error(`Explore section query failed: ${message}`);
  }
}

export async function queryExploreGrouped(
  params: ExploreQueryParams,
  _now?: Date,
): Promise<GroupedExploreResult> {
  const supabase = createAnonClient();
  if (!supabase) {
    return {
      closingSoon: { polls: [], nextCursor: null, hasMore: false },
      liveNow: { polls: [], nextCursor: null, hasMore: false },
      recentlyClosed: { polls: [], nextCursor: null, hasMore: false },
    };
  }

  const now = _now ?? new Date();
  const defaultLimit = params.section ? GROUP_MORE_LIMIT : GROUP_FIRST_LIMIT;
  const limit = Math.max(1, Math.min(params.limit || defaultLimit, MAX_LIMIT));

  if (params.section) {
    // Single-section Load more
    const result = await querySection(supabase, params, params.section, now, limit);
    return {
      closingSoon: params.section === "closing_soon" ? result : { polls: [], nextCursor: null, hasMore: false },
      liveNow: params.section === "live_now" ? result : { polls: [], nextCursor: null, hasMore: false },
      recentlyClosed: params.section === "recently_closed" ? result : { polls: [], nextCursor: null, hasMore: false },
    };
  }

  // Initial grouped load: all 3 sections
  const [closingSoon, liveNow, recentlyClosed] = await Promise.all([
    querySection(supabase, params, "closing_soon", now, GROUP_FIRST_LIMIT),
    querySection(supabase, params, "live_now", now, GROUP_FIRST_LIMIT),
    querySection(supabase, params, "recently_closed", now, GROUP_FIRST_LIMIT),
  ]);

  return { closingSoon, liveNow, recentlyClosed };
}
