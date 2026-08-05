"use client";

import {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { CATEGORY_LABELS, FORMAT_LABELS, POLL_CATEGORIES, POLL_FORMATS } from "@/lib/polls/taxonomy";
import type {
  ExploreSortMode,
  PollSection,
} from "@/lib/explore/filters";
import { parseExploreParams, buildExploreUrl, hasNonDefaultFilters } from "@/lib/explore/url-params";
import type {
  ExploreFilterState,
  ExploreQueryResult,
  GroupedExploreResult,
  PollCardData,
} from "@/lib/explore/types";
import { ProductShell } from "@/components/layout/ProductShell";
import { UnavailableState } from "@/components/state/UnavailableState";
import { ErrorState } from "@/components/state/ErrorState";
import { LoadingState } from "@/components/state/LoadingState";
import { PollCard } from "@/components/product/PollCard";
import { Card } from "@/components/ui/Card";
import { ArrowUpRightIcon, SearchIcon } from "@/components/ui/icons";
import { createDebouncedSearch } from "@/lib/explore/debounce";

// ── Props ─────────────────────────────────────────────────────────────

export interface ExploreClientProps {
  configUnavailable: boolean;
  errorMessage: string | null;
  currentTime: string;
  initialFilters: ExploreFilterState | null;
  initialResult: ExploreQueryResult | GroupedExploreResult | null;
}

// ── Helpers ───────────────────────────────────────────────────────────

const goldPillLinkClasses =
  "inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

const DEFAULT_FILTERS: ExploreFilterState = {
  search: "", category: null, format: null, status: "all", sort: "grouped",
};

const DEBOUNCE_MS = 300;

const STATUS_FILTERS = [
  { value: "all", label: "All polls" },
  { value: "live", label: "Live" },
  { value: "closed", label: "Closed" },
] as const;

const SORT_OPTIONS: { value: ExploreSortMode; label: string }[] = [
  { value: "grouped", label: "Grouped by status" },
  { value: "recent", label: "Recently created" },
  { value: "closing", label: "Closing first" },
];

/** Append poll items, preserving order, skipping duplicate IDs already present. */
function appendUnique(existing: PollCardData[], incoming: PollCardData[]): PollCardData[] {
  const existingIds = new Set(existing.map((p) => p.id));
  const unique = incoming.filter((p) => !existingIds.has(p.id));
  // Deduplicate within incoming
  const seen = new Set<string>();
  const deduped: PollCardData[] = [];
  for (const p of unique) {
    if (!seen.has(p.id)) { seen.add(p.id); deduped.push(p); }
  }
  return [...existing, ...deduped];
}

function isFlat(sort: ExploreSortMode): boolean {
  return sort === "recent" || sort === "closing";
}

// ── Component ─────────────────────────────────────────────────────────

export function ExploreClient({
  configUnavailable,
  errorMessage: serverErrorMessage,
  currentTime,
  initialFilters: serverFilters,
  initialResult,
}: ExploreClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── URL-derived filter state (authoritative) ─────────────────────
  const filters = useMemo<ExploreFilterState>(
    () => (serverFilters ?? parseExploreParams(searchParams)),
    [searchParams, serverFilters],
  );

  // ── Search input state (immediate) + debounced value ────────────
  const [searchText, setSearchText] = useState(filters.search);
  const debouncedSearch = useRef<ReturnType<typeof createDebouncedSearch> | null>(null);

  // Initialise debounce controller once
  useEffect(() => {
    debouncedSearch.current = createDebouncedSearch((trimmed) => {
      applyFilterChange((prev) => ({ ...prev, search: trimmed }));
    }, DEBOUNCE_MS);
    return () => { debouncedSearch.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSearchChange(value: string) {
    setSearchText(value);
    debouncedSearch.current?.notify(value);
  }

  // ── Request tracking ────────────────────────────────────────────
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function nextRequestId(): number {
    requestIdRef.current += 1;
    return requestIdRef.current;
  }

  function cancelPending() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  // ── Data state ──────────────────────────────────────────────────
  const [flatPolls, setFlatPolls] = useState<PollCardData[]>(
    initialResult && isFlat(filters.sort)
      ? (initialResult as ExploreQueryResult).polls
      : [],
  );
  // used by V2A.7E Load more — kept for cursor continuity
  const [_flatCursor, setFlatCursor] = useState<string | null>(
    initialResult && isFlat(filters.sort)
      ? (initialResult as ExploreQueryResult).nextCursor
      : null,
  );
  void _flatCursor;
  // used by V2A.7E Load more — kept for cursor continuity
  const [_flatHasMore, setFlatHasMore] = useState<boolean>(
    initialResult && isFlat(filters.sort)
      ? (initialResult as ExploreQueryResult).hasMore
      : false,
  );
  void _flatHasMore;

  const emptySection = (): ExploreQueryResult => ({ polls: [], nextCursor: null, hasMore: false });
  const [grouped, setGrouped] = useState<Record<PollSection, ExploreQueryResult>>(() => {
    const gr = initialResult as GroupedExploreResult | null;
    return {
      closing_soon: gr?.closingSoon ?? emptySection(),
      live_now: gr?.liveNow ?? emptySection(),
      recently_closed: gr?.recentlyClosed ?? emptySection(),
    };
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(serverErrorMessage);

  // ── Apply filter change ─────────────────────────────────────────
  function applyFilterChange(
    updater: (prev: ExploreFilterState) => ExploreFilterState,
  ) {
    cancelPending();
    const newFilters = updater(filters);
    const url = buildExploreUrl(newFilters);

    // Only replace if URL actually changed
    if (url !== buildExploreUrl(filters)) {
      router.replace(url);
    }

    // Reset data
    setFlatPolls([]);
    setFlatCursor(null);
    setFlatHasMore(false);
    setGrouped({ closing_soon: emptySection(), live_now: emptySection(), recently_closed: emptySection() });
    setError(null);

    // Fetch first page
    fetchResults(newFilters, null, null);
  }

  // ── Fetch results ───────────────────────────────────────────────
  async function fetchResults(
    filterState: ExploreFilterState,
    section: PollSection | null,
    cursor: string | null,
  ) {
    const rid = nextRequestId();
    const ac = new AbortController();
    if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ok */ } }
    abortRef.current = ac;
    setLoading(true);

    try {
      const params = new URLSearchParams();
      if (filterState.search) params.set("q", filterState.search);
      if (filterState.category) params.set("category", filterState.category);
      if (filterState.format) params.set("format", filterState.format);
      if (filterState.status !== "all") params.set("status", filterState.status);
      if (filterState.sort !== "grouped") params.set("sort", filterState.sort);
      if (section) params.set("section", section);
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/explore?${params.toString()}`, {
        signal: ac.signal,
      });

      if (ac.signal.aborted) return;
      if (rid !== requestIdRef.current) return; // stale

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (rid !== requestIdRef.current) return;
        setError(body.message ?? "Query failed");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (rid !== requestIdRef.current) return;

      if (isFlat(filterState.sort)) {
        const r = data as ExploreQueryResult;
        setFlatPolls((prev) => appendUnique(cursor ? prev : [], r.polls));
        setFlatCursor(r.nextCursor);
        setFlatHasMore(r.hasMore);
      } else {
        const gr = data as GroupedExploreResult;
        setGrouped((prev) => ({
          closing_soon: section === "closing_soon"
            ? { ...gr.closingSoon, polls: appendUnique(section ? prev.closing_soon.polls : [], gr.closingSoon.polls) }
            : prev.closing_soon,
          live_now: section === "live_now"
            ? { ...gr.liveNow, polls: appendUnique(section ? prev.live_now.polls : [], gr.liveNow.polls) }
            : prev.live_now,
          recently_closed: section === "recently_closed"
            ? { ...gr.recentlyClosed, polls: appendUnique(section ? prev.recently_closed.polls : [], gr.recentlyClosed.polls) }
            : prev.recently_closed,
        }));
      }
      setError(null);
    } catch (err: unknown) {
      if (ac.signal.aborted) return;
      if (rid !== requestIdRef.current) return;
      const msg = err instanceof Error ? err.message : "Request failed";
      if (msg !== "The user aborted a request.") {
        setError(msg);
      }
    } finally {
      if (rid === requestIdRef.current) setLoading(false);
    }
  }

  // ── Filter change handlers ──────────────────────────────────────
  const onCategoryChange = useCallback((cat: PollCategory | "all") => {
    applyFilterChange((prev) => ({ ...prev, category: cat === "all" ? null : cat }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const onFormatChange = useCallback((fmt: PollFormat | "all") => {
    applyFilterChange((prev) => ({ ...prev, format: fmt === "all" ? null : fmt }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const onStatusChange = useCallback((status: "all" | "live" | "closed") => {
    applyFilterChange((prev) => ({ ...prev, status }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const onSortChange = useCallback((sort: ExploreSortMode) => {
    applyFilterChange((prev) => ({ ...prev, sort }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Clear filters
  function handleClearFilters() {
    cancelPending();
    setSearchText("");
    debouncedSearch.current?.cancel();
    debouncedSearch.current?.reset();
    setFlatPolls([]);
    setFlatCursor(null);
    setFlatHasMore(false);
    setGrouped({ closing_soon: emptySection(), live_now: emptySection(), recently_closed: emptySection() });
    setError(null);
    router.replace("/explore");
    fetchResults(DEFAULT_FILTERS, null, null);
  }

  function handleRetry() {
    fetchResults(filters, null, null);
  }

  // ── Compute display state ───────────────────────────────────────
  const showClear = hasNonDefaultFilters(filters);

  const effectiveNow = useMemo(() => new Date(currentTime).getTime(), [currentTime]);

  function effectiveCloseStatus(p: PollCardData): "live" | "closed" {
    if (p.status === "closed") return "closed";
    if (!p.closingAt) return "live";
    return new Date(p.closingAt).getTime() <= effectiveNow ? "closed" : "live";
  }

  function renderCards(polls: PollCardData[]) {
    return polls.map((p) => (
      <PollCard
        key={p.id}
        question={p.question}
        optionCount={p.optionCount}
        status={effectiveCloseStatus(p)}
        href={`/polls/${p.id}`}
        category={p.category as PollCategory}
        format={p.format as PollFormat}
        closingAt={p.closingAt || undefined}
      />
    ));
  }

  function sectionHeading(label: string, count: number) {
    return (
      <h2 className="text-micro text-quiet-ink tracking-wider mb-3">
        {label} &middot; {count}
      </h2>
    );
  }

  // ── Render ──────────────────────────────────────────────────────
  if (configUnavailable) {
    return (
      <ProductShell>
        <UnavailableState
          title="Public poll data is not connected"
          description="The Supabase database hasn't been configured yet."
        />
      </ProductShell>
    );
  }

  if (serverErrorMessage && !initialResult) {
    return (
      <ProductShell>
        <ErrorState
          title="Could not load public polls"
          description={serverErrorMessage}
          onRetry={() => window.location.reload()}
        />
      </ProductShell>
    );
  }

  const totalPolls = isFlat(filters.sort)
    ? flatPolls.length
    : grouped.closing_soon.polls.length + grouped.live_now.polls.length + grouped.recently_closed.polls.length;

  return (
    <ProductShell>
      {/* Hero */}
      <Card glass className="mb-6 p-6 sm:p-8">
        <div className="flex items-center gap-1.5 text-micro text-quiet-ink tracking-wider mb-2">
          <ArrowUpRightIcon className="flex-shrink-0" />
          PUBLIC VOTUM POLLS
        </div>
        <h1 className="max-w-[520px] text-page-title font-display text-ballot-ink">
          Explore what people are deciding and predicting.
        </h1>
        <p className="text-body text-quiet-ink mt-3 max-w-prose">
          Browse verified polls across sports, entertainment, brands and communities.
          One wallet gets one vote, while optional NIM support is counted separately.
        </p>
        <div className="mt-6">
          <Link href="/create" className={goldPillLinkClasses}>
            Create a Votum Poll
          </Link>
        </div>
      </Card>

      {/* Category rail */}
      <div className="mb-4">
        <div className="sr-only" id="category-filter-label">Filter by category</div>
        <div
          role="group" aria-labelledby="category-filter-label"
          className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1"
        >
          {(["all", ...POLL_CATEGORIES] as Array<"all" | PollCategory>).map((cat) => {
            const active = cat === "all" ? filters.category === null : filters.category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onCategoryChange(cat)}
                aria-pressed={active}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                  active
                    ? "bg-ballot-ink text-clear-ballot"
                    : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                }`}
              >
                {cat === "all" ? "All" : CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Format rail */}
      <div className="mb-4">
        <div className="sr-only" id="format-filter-label">Filter by participation format</div>
        <div
          role="group" aria-labelledby="format-filter-label"
          className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1"
        >
          {(["all", ...POLL_FORMATS] as Array<"all" | PollFormat>).map((fmt) => {
            const active = fmt === "all" ? filters.format === null : filters.format === fmt;
            return (
              <button
                key={fmt}
                type="button"
                onClick={() => onFormatChange(fmt)}
                aria-pressed={active}
                className={`shrink-0 rounded-full px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                  active
                    ? "bg-ballot-ink text-clear-ballot"
                    : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                }`}
              >
                {fmt === "all" ? "All formats" : FORMAT_LABELS[fmt]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <Card glass className="mb-6 p-3 sm:p-4">
        <div className="flex flex-col gap-3">
          {/* Search */}
          <div className="relative w-full">
            <input
              type="text"
              value={searchText}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search public polls"
              aria-label="Search public polls"
              className="w-full rounded-full border border-border bg-clear-ballot/72 py-2.5 pl-10 pr-4 text-sm text-ballot-ink placeholder:text-micro-grey transition-colors focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold"
            />
            <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 text-micro-grey" />
          </div>

          {/* Status + Sort + Clear */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Status filter">
              {STATUS_FILTERS.map((filter) => {
                const active = filters.status === filter.value;
                return (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => onStatusChange(filter.value)}
                    aria-pressed={active}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                      active
                        ? "bg-ballot-ink text-clear-ballot"
                        : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                    }`}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="explore-sort" className="text-sm text-quiet-ink">Sort polls</label>
              <select
                id="explore-sort"
                value={filters.sort}
                onChange={(e) => onSortChange(e.target.value as ExploreSortMode)}
                className="rounded-full border border-border bg-clear-ballot/60 px-3.5 py-2 text-sm text-ballot-ink focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Clear filters */}
          {showClear && (
            <button
              type="button"
              onClick={handleClearFilters}
              aria-label="Clear all filters"
              className="text-sm text-nim-blue hover:underline self-start"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* Results */}
      {loading && totalPolls === 0 ? (
        <LoadingState variant="list" count={3} />
      ) : error && totalPolls === 0 ? (
        <ErrorState title="Could not load polls" description={error} onRetry={handleRetry} />
      ) : totalPolls === 0 ? (
        <div className="text-center py-12">
          <p className="text-body text-quiet-ink">No polls match your filters.</p>
          <div className="mt-6">
            <Link href="/create" className={goldPillLinkClasses}>
              Create a Votum Poll
            </Link>
          </div>
        </div>
      ) : isFlat(filters.sort) ? (
        <div>
          {sectionHeading(filters.sort === "recent" ? "Recently created" : "Closing first", flatPolls.length)}
          <div className="space-y-4">{renderCards(flatPolls)}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {(["closing_soon", "live_now", "recently_closed"] as PollSection[]).map((sec) => {
            const sp = grouped[sec].polls;
            if (sp.length === 0) return null;
            const label = sec === "closing_soon" ? "Closing soon" : sec === "live_now" ? "Live now" : "Recently closed";
            return (
              <div key={sec}>
                {sectionHeading(label, sp.length)}
                <div className="space-y-4">{renderCards(sp)}</div>
              </div>
            );
          })}
        </div>
      )}
    </ProductShell>
  );
}
