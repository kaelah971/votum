/**
 * V2A.7 Shared Explore Contracts
 *
 * Types consumed by the server query layer, client controller, cursor
 * utilities, and URL helpers.  No Supabase or browser dependency.
 */

import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import type { PollStatus } from "@/types/poll";
import type {
  ExploreSortMode,
  PollSection,
} from "@/lib/explore/filters";

// ── Filter State ──────────────────────────────────────────────────────
// Canonical representation of all Explore filters.

export interface ExploreFilterState {
  search: string;                     // trimmed, "" = no search (default)
  category: PollCategory | null;      // null = all (default)
  format: PollFormat | null;          // null = all (default)
  status: "all" | "live" | "closed";  // "all" = default
  sort: ExploreSortMode;              // "grouped" = default
}

// ── Poll Card Data ────────────────────────────────────────────────────
// Minimal public shape consumed by PollCard on the Explore page.
// Excludes destination wallets, contribution mode, and other private fields.

export interface PollCardData {
  id: string;
  question: string;
  context?: string;
  category: PollCategory;
  format: PollFormat;
  status: PollStatus;            // stored DB status (client derives effectiveStatus)
  closingAt: string;             // raw ISO from ends_at; may be empty for no deadline
  createdAt: string;             // raw ISO
  optionCount: number;
}

// ── Server Query Contracts ────────────────────────────────────────────
// Used by the server query layer (explore-queries.ts, V2A.7B/V2A.7C).

export interface ExploreQueryParams {
  search: string;
  category: PollCategory | null;
  format: PollFormat | null;
  status: "all" | "live" | "closed";
  sort: ExploreSortMode;
  section?: PollSection;   // only for grouped Load more
  cursor?: string;         // opaque base64url-encoded JSON
  limit: number;           // clamped [1, 24]; default 12 (4 for grouped first)
}

export interface ExploreQueryResult {
  polls: PollCardData[];
  nextCursor: string | null;   // null = no more pages
  hasMore: boolean;
}

export interface GroupedExploreResult {
  closingSoon: ExploreQueryResult;
  liveNow: ExploreQueryResult;
  recentlyClosed: ExploreQueryResult;
}
