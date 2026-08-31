/**
 * V2A.7 Explore URL Parameter Model
 *
 * Parses and serialises the canonical Explore query string.
 * Only non-default values appear in the URL.
 * Invalid values are silently dropped.
 */

import type { ExploreFilterState } from "@/lib/explore/types";
import {
  isPollCategory,
  isPollFormat,
  type PollCategory,
  type PollFormat,
} from "@/lib/polls/taxonomy";
import type { ExploreSortMode } from "@/lib/explore/filters";

// ── Constants ─────────────────────────────────────────────────────────

const MAX_SEARCH_LENGTH = 200;

const VALID_STATUSES: ReadonlySet<string> = new Set(["live", "closed"]);

const VALID_SORTS: ReadonlySet<string> = new Set(["recent", "closing"]);

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULTS: ExploreFilterState = {
  search: "",
  category: null,
  format: null,
  status: "all",
  sort: "grouped",
  rewarded: false,
};

// ── Helpers ───────────────────────────────────────────────────────────

function isValidStatus(value: string): value is "live" | "closed" {
  return VALID_STATUSES.has(value);
}

function isValidSort(value: string): value is ExploreSortMode {
  // "grouped" is the default and never appears in the URL, but we still
  // accept it if explicitly provided for robustness.
  return value === "grouped" || VALID_SORTS.has(value);
}

// ── parseExploreParams ─────────────────────────────────────────────────
//
// Reads URLSearchParams and returns an ExploreFilterState.
// Invalid values are dropped; missing values get defaults.
// Search is trimmed and clamped to MAX_SEARCH_LENGTH.

export function parseExploreParams(
  searchParams: URLSearchParams,
): ExploreFilterState {
  const state: ExploreFilterState = { ...DEFAULTS };

  // q
  const rawQ = searchParams.get("q");
  if (rawQ !== null) {
    const trimmed = rawQ.trim();
    if (trimmed.length > 0) {
      state.search = trimmed.slice(0, MAX_SEARCH_LENGTH);
    }
  }

  // category
  const rawCat = searchParams.get("category");
  if (rawCat !== null) {
    const trimmed = rawCat.trim();
    if (isPollCategory(trimmed)) {
      state.category = trimmed as PollCategory;
    }
  }

  // format
  const rawFmt = searchParams.get("format");
  if (rawFmt !== null) {
    const trimmed = rawFmt.trim();
    if (isPollFormat(trimmed)) {
      state.format = trimmed as PollFormat;
    }
  }

  // status
  const rawStatus = searchParams.get("status");
  if (rawStatus !== null) {
    const trimmed = rawStatus.trim();
    if (isValidStatus(trimmed)) {
      state.status = trimmed;
    }
  }

  // sort
  const rawSort = searchParams.get("sort");
  if (rawSort !== null) {
    const trimmed = rawSort.trim();
    if (isValidSort(trimmed)) {
      state.sort = trimmed;
    }
  }

  // rewarded
  const rawRewarded = searchParams.get("rewarded");
  if (rawRewarded === "1" || rawRewarded === "true") {
    state.rewarded = true;
  }

  return state;
}

// ── buildExploreUrl ────────────────────────────────────────────────────
//
// Serialises an ExploreFilterState to a canonical query string.
// Default values are omitted.
  // Parameter order is deterministic: q, category, format, status, sort, rewarded.

export function buildExploreUrl(state: ExploreFilterState): string {
  const params = new URLSearchParams();

  if (state.search !== DEFAULTS.search && state.search.trim() !== "") {
    params.set("q", state.search.trim());
  }

  if (state.category !== DEFAULTS.category && state.category !== null) {
    params.set("category", state.category);
  }

  if (state.format !== DEFAULTS.format && state.format !== null) {
    params.set("format", state.format);
  }

  if (state.status !== DEFAULTS.status) {
    params.set("status", state.status);
  }

  if (state.sort !== DEFAULTS.sort) {
    params.set("sort", state.sort);
  }

  if (state.rewarded) {
    params.set("rewarded", "1");
  }

  const qs = params.toString();
  return qs ? `/explore?${qs}` : "/explore";
}

// ── hasNonDefaultFilters ───────────────────────────────────────────────

export function hasNonDefaultFilters(state: ExploreFilterState): boolean {
  return (
    state.search !== DEFAULTS.search ||
    state.category !== DEFAULTS.category ||
    state.format !== DEFAULTS.format ||
    state.status !== DEFAULTS.status ||
    state.sort !== DEFAULTS.sort
    || state.rewarded === true
  );
}
