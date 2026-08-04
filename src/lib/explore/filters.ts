import type { PollView } from "@/types/poll";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";

export type CategoryFilter = "all" | PollCategory;
export type FormatFilter = "all" | PollFormat;

export const CLOSING_SOON_HOURS = 72;
export const CLOSING_SOON_MS = CLOSING_SOON_HOURS * 60 * 60 * 1000;

export type PollSection = "closing_soon" | "live_now" | "recently_closed";

export type ExploreSortMode = "grouped" | "recent" | "closing";

export type EffectiveExploreStatus = "live" | "closed";

export interface EnrichedPollView extends PollView {
  effectiveStatus: EffectiveExploreStatus;
}

export interface GroupedPolls {
  closingSoon: EnrichedPollView[];
  liveNow: EnrichedPollView[];
  recentlyClosed: EnrichedPollView[];
}

/** Parse an ISO-8601 timestring to epoch ms, returning null for invalid inputs. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Derive whether the poll is effectively live or closed for Explore display. */
export function effectiveStatus(
  poll: Pick<PollView, "status" | "closingAt">,
  nowMs: number,
): EffectiveExploreStatus {
  if (poll.status === "closed") return "closed";

  const endsAt = parseTimestamp(poll.closingAt);
  if (endsAt === null) return "live";       // missing/invalid deadline → live
  if (endsAt <= nowMs) return "closed";      // expired

  return "live";                             // still open
}

export function classifyPollSection(
  poll: Pick<PollView, "status" | "closingAt">,
  nowMs: number,
): PollSection {
  const status = effectiveStatus(poll, nowMs);
  if (status === "closed") return "recently_closed";

  const endsAtMs = parseTimestamp(poll.closingAt);
  if (endsAtMs === null) return "live_now";  // missing/invalid deadline → Live now
  if (endsAtMs <= nowMs + CLOSING_SOON_MS) return "closing_soon";

  return "live_now";
}

/**
 * Compare two timestamps ascending.  Invalid / missing values sort after
 * valid values.  Ties are broken by poll id.
 */
function compareTimestampsAsc(
  a: number | null,
  b: number | null,
  idA: string,
  idB: string,
): number {
  if (a === null && b === null) return idA.localeCompare(idB);
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b || idA.localeCompare(idB);
}

/**
 * Compare two timestamps descending.  Invalid / missing values sort after
 * valid values.  Ties are broken by poll id (same direction as ascending).
 */
function compareTimestampsDesc(
  a: number | null,
  b: number | null,
  idA: string,
  idB: string,
): number {
  if (a === null && b === null) return idA.localeCompare(idB);
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a || idA.localeCompare(idB);
}

export function matchesSearch(poll: Pick<PollView, "question" | "context">, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase().trim();
  return (
    poll.question.toLowerCase().includes(q) ||
    (poll.context?.toLowerCase().includes(q) ?? false)
  );
}

export function matchesCategory(
  poll: Pick<PollView, "category">,
  filter: CategoryFilter,
): boolean {
  if (filter === "all") return true;
  return poll.category === filter;
}

export function matchesFormat(
  poll: Pick<PollView, "format">,
  filter: FormatFilter,
): boolean {
  if (filter === "all") return true;
  return poll.format === filter;
}

export function filterAndGroupPolls(
  polls: PollView[],
  options: {
    search: string;
    category: CategoryFilter;
    format: FormatFilter;
    statusFilter: "all" | "live" | "closed";
    nowMs: number;
  },
): GroupedPolls {
  const enriched: EnrichedPollView[] = polls.map((p) => ({
    ...p,
    effectiveStatus: effectiveStatus(p, options.nowMs),
  }));

  let results = [...enriched];

  if (options.statusFilter === "live") {
    results = results.filter((p) => p.effectiveStatus === "live");
  } else if (options.statusFilter === "closed") {
    results = results.filter((p) => p.effectiveStatus === "closed");
  }

  if (options.search.trim()) {
    const q = options.search.toLowerCase().trim();
    results = results.filter(
      (p) =>
        p.question.toLowerCase().includes(q) ||
        (p.context?.toLowerCase().includes(q) ?? false),
    );
  }

  if (options.category !== "all") {
    results = results.filter((p) => p.category === options.category);
  }

  if (options.format !== "all") {
    results = results.filter((p) => p.format === options.format);
  }

  const closingSoon: EnrichedPollView[] = [];
  const liveNow: EnrichedPollView[] = [];
  const recentlyClosed: EnrichedPollView[] = [];

  for (const poll of results) {
    const section = classifyPollSection(poll, options.nowMs);
    if (section === "closing_soon") closingSoon.push(poll);
    else if (section === "live_now") liveNow.push(poll);
    else recentlyClosed.push(poll);
  }

  // Closing soon: earliest closing first; invalid deadlines sort last
  closingSoon.sort((a, b) =>
    compareTimestampsAsc(
      parseTimestamp(a.closingAt),
      parseTimestamp(b.closingAt),
      a.id,
      b.id,
    ),
  );

  // Live now: newest created first; invalid dates sort last
  liveNow.sort((a, b) =>
    compareTimestampsDesc(
      parseTimestamp(a.createdAt),
      parseTimestamp(b.createdAt),
      a.id,
      b.id,
    ),
  );

  // Recently closed: most recently closed first; invalid dates sort last
  recentlyClosed.sort((a, b) =>
    compareTimestampsDesc(
      parseTimestamp(a.closingAt),
      parseTimestamp(b.closingAt),
      a.id,
      b.id,
    ),
  );

  return { closingSoon, liveNow, recentlyClosed };
}

// ---------------------------------------------------------------------------
// Unified sort-mode results
// ---------------------------------------------------------------------------

export type FlatPollList = EnrichedPollView[];

export type SortedResults =
  | { mode: "grouped"; groups: GroupedPolls }
  | { mode: "recent"; polls: FlatPollList }
  | { mode: "closing"; polls: FlatPollList };

export function filterAndSortResults(
  polls: PollView[],
  options: {
    search: string;
    category: CategoryFilter;
    format: FormatFilter;
    statusFilter: "all" | "live" | "closed";
    sortMode: ExploreSortMode;
    nowMs: number;
  },
): SortedResults {
  const { sortMode, ...filterOpts } = options;
  const grouped = filterAndGroupPolls(polls, filterOpts);

  if (sortMode === "grouped") {
    return { mode: "grouped", groups: grouped };
  }

  let flat: EnrichedPollView[] = [
    ...grouped.closingSoon,
    ...grouped.liveNow,
    ...grouped.recentlyClosed,
  ];

  if (sortMode === "recent") {
    flat.sort((a, b) =>
      compareTimestampsDesc(
        parseTimestamp(a.createdAt),
        parseTimestamp(b.createdAt),
        a.id,
        b.id,
      ),
    );
    return { mode: "recent", polls: flat };
  }

  // closing mode: only effective-live with valid future deadline (no 72h bound)
  flat = [...grouped.closingSoon, ...grouped.liveNow]
    .filter((p) => parseTimestamp(p.closingAt) !== null);
  flat.sort((a, b) =>
    compareTimestampsAsc(
      parseTimestamp(a.closingAt),
      parseTimestamp(b.closingAt),
      a.id,
      b.id,
    ),
  );
  return { mode: "closing", polls: flat };
}
