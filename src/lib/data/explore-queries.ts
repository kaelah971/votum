/**
 * V2A.7B — Server-Side Explore Query Layer (Flat Pagination)
 *
 * Provides cursor-based paginated queries for the Explore page.
 * Uses the anonymous publishable key (no service_role).
 * Filtering, ordering, and pagination are database-driven.
 *
 * Only flat modes are implemented here: "recent" and "closing".
 * Grouped mode (closing_soon / live_now / recently_closed) is in V2A.7C.
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
  PollCardData,
} from "@/lib/explore/types";

// ── Configuration ─────────────────────────────────────────────────────

const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;

const MAX_SEARCH_LENGTH = 200;

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

// ── Status helper (handles effective-status for "live" and "closed") ──
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
    parts.push(
      `or(question.ilike.%${search}%,description.ilike.%${search}%)`,
    );
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

    // Search
    if (search) {
      query = query.or(
        `question.ilike.%${search}%,description.ilike.%${search}%`,
      );
    }

    // Build the combined OR filter (status + search + cursor)
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const combinedOr = buildCombinedOrFilter(search, cursor, sort, status);

    // Mode-specific ordering and limits
    if (sort === "closing") {
      // Closing first: live polls only, valid future deadlines
      query = query.eq("status", "live").not("ends_at", "is", null);

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
    console.error("[explore-queries]", message);
    return { polls: [], nextCursor: null, hasMore: false };
  }
}
