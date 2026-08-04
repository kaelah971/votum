"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { PollView } from "@/types/poll";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { CATEGORY_LABELS, FORMAT_LABELS, POLL_CATEGORIES, POLL_FORMATS } from "@/lib/polls/taxonomy";
import {
  filterAndSortResults,
  type CategoryFilter,
  type FormatFilter,
  type EnrichedPollView,
  type ExploreSortMode,
} from "@/lib/explore/filters";
import { ProductShell } from "@/components/layout/ProductShell";
import { UnavailableState } from "@/components/state/UnavailableState";
import { ErrorState } from "@/components/state/ErrorState";
import { EmptyState } from "@/components/state/EmptyState";
import { LoadingState } from "@/components/state/LoadingState";
import { ExploreToolbar } from "@/components/explore/ExploreToolbar";
import { PollCard } from "@/components/product/PollCard";
import { Card } from "@/components/ui/Card";
import { ArrowUpRightIcon } from "@/components/ui/icons";

export interface ExploreClientProps {
  polls: PollView[] | null;
  configUnavailable: boolean;
  errorMessage: string | null;
  isLoading?: boolean;
  currentTime: string;
}

const goldPillLinkClasses =
  "inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

function EmptyBallotIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <rect x="6" y="10" width="36" height="34" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="20" y="4" width="8" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="18" width="20" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <line x1="18" y1="23" x2="30" y2="23" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="18" y1="27" x2="26" y2="27" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function renderPollCard(poll: EnrichedPollView) {
  return (
    <PollCard
      key={poll.id}
      question={poll.question}
      optionCount={poll.options.length}
      status={poll.effectiveStatus}
      href={`/polls/${poll.id}`}
      category={poll.category as PollCategory}
      format={poll.format as PollFormat}
      closingAt={poll.closingAt}
    />
  );
}

function buildSectionHeading(label: string, count: number) {
  return (
    <h2 className="text-micro text-quiet-ink tracking-wider mb-3">
      {label} &middot; {count}
    </h2>
  );
}

function buildEmptyMessage(
  category: CategoryFilter,
  format: FormatFilter,
  statusFilter: string,
  search: string,
  sortMode: ExploreSortMode,
): string {
  if (statusFilter === "closed" && sortMode === "closing") {
    return "No closed polls have an upcoming deadline.";
  }

  const parts: string[] = [];
  if (search.trim()) parts.push(`"${search.trim()}"`);
  if (category !== "all") parts.push(CATEGORY_LABELS[category]);
  if (format !== "all") parts.push(FORMAT_LABELS[format]);

  let subject = "";
  if (parts.length > 0) {
    // Natural composition: "Entertainment fan votes" not "Entertainment, Fan vote"
    subject = parts.join(" ") + " ";
  }

  if (sortMode === "closing") {
    if (statusFilter === "live") return `No upcoming live ${subject}polls match your filters.`;
    if (parts.length > 0) return `No upcoming ${subject}polls match your filters.`;
    return "No polls have an upcoming deadline.";
  }

  if (sortMode === "recent") {
    if (statusFilter === "live") return `No recently created live ${subject}polls match your search.`;
    if (statusFilter === "closed") return `No recently created closed ${subject}polls match your search.`;
    if (parts.length > 0) return `No recently created ${subject}polls match your search.`;
  }

  // grouped
  if (statusFilter === "live") return `No live ${subject}polls match your search.`;
  if (statusFilter === "closed") return `No closed ${subject}polls match your search.`;
  if (parts.length > 0) return `No ${subject}polls match your search.`;
  return "No public polls available yet.";
}

export function ExploreClient({
  polls,
  configUnavailable,
  errorMessage,
  isLoading = false,
  currentTime,
}: ExploreClientProps) {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "closed">("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");
  const [sortMode, setSortMode] = useState<ExploreSortMode>("grouped");

  const nowMs = useMemo(() => new Date(currentTime).getTime(), [currentTime]);

  const sorted = useMemo(() => {
    if (!polls || polls.length === 0) return null;
    return filterAndSortResults(polls, {
      search: searchQuery,
      category: categoryFilter,
      format: formatFilter,
      statusFilter,
      sortMode,
      nowMs,
    });
  }, [polls, searchQuery, categoryFilter, formatFilter, statusFilter, sortMode, nowMs]);

  function totalCount(): number {
    if (!sorted) return 0;
    if (sorted.mode === "grouped") {
      return sorted.groups.closingSoon.length +
        sorted.groups.liveNow.length +
        sorted.groups.recentlyClosed.length;
    }
    return sorted.polls.length;
  }

  function renderContent() {
    if (isLoading) return <LoadingState variant="list" count={3} />;

    if (configUnavailable) {
      return (
        <UnavailableState
          title="Public poll data is not connected"
          description="The Supabase database hasn't been configured yet."
        />
      );
    }

    if (errorMessage) {
      return (
        <ErrorState
          title="Could not load public polls"
          description="Something went wrong. Please try again."
          onRetry={() => window.location.reload()}
        />
      );
    }

    if (polls && polls.length === 0) {
      return (
        <EmptyState
          icon={<EmptyBallotIcon className="w-12 h-12" />}
          title="No public polls to explore yet."
          description="Public polls will appear here once they are available."
          action={
            <div className="flex flex-col gap-3">
              <Link href="/create" className={goldPillLinkClasses}>
                Create a Votum Poll
              </Link>
              <Link href="/how-it-works" className="text-body text-quiet-ink hover:text-ballot-ink transition-colors">
                See how Votum works
              </Link>
            </div>
          }
        />
      );
    }

    if (!polls || !sorted) return null;

    const count = totalCount();

    return (
      <>
        {/* Discovery toolbar */}
        <Card glass className="mb-6 p-3 sm:p-4">
          <ExploreToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            sortBy={sortMode}
            onSortChange={setSortMode}
          />
        </Card>

        {/* Empty state */}
        {count === 0 ? (
          <div className="text-center py-12">
            <p className="text-body text-quiet-ink">
              {buildEmptyMessage(categoryFilter, formatFilter, statusFilter, searchQuery, sortMode)}
            </p>
            <div className="mt-6">
              <Link href="/create" className={goldPillLinkClasses}>
                Create a Votum Poll
              </Link>
            </div>
          </div>
        ) : sorted.mode === "grouped" ? (
          /* Grouped: three sections */
          <div className="flex flex-col gap-8">
            {(["closing_soon", "live_now", "recently_closed"] as const).map((section) => {
              const sp: EnrichedPollView[] =
                section === "closing_soon"
                  ? sorted.groups.closingSoon
                  : section === "live_now"
                  ? sorted.groups.liveNow
                  : sorted.groups.recentlyClosed;
              if (sp.length === 0) return null;
              const label =
                section === "closing_soon" ? "Closing soon" :
                section === "live_now" ? "Live now" : "Recently closed";
              return (
                <div key={section}>
                  {buildSectionHeading(label, sp.length)}
                  <div className="space-y-4">{sp.map(renderPollCard)}</div>
                </div>
              );
            })}
          </div>
        ) : sorted.mode === "recent" ? (
          /* Recently created: one flat section */
          <div>
            {buildSectionHeading("Recently created", sorted.polls.length)}
            <div className="space-y-4">{sorted.polls.map(renderPollCard)}</div>
          </div>
        ) : (
          /* Closing first: one flat section */
          <div>
            {buildSectionHeading("Closing first", sorted.polls.length)}
            <div className="space-y-4">{sorted.polls.map(renderPollCard)}</div>
          </div>
        )}
      </>
    );
  }

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

      {/* Category filter */}
      {polls && polls.length > 0 && !configUnavailable && !errorMessage && (
        <div className="mb-4">
          <div className="sr-only" id="category-filter-label">Filter by category</div>
          <div
            role="group"
            aria-labelledby="category-filter-label"
            className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1"
          >
            {(["all", ...POLL_CATEGORIES] as CategoryFilter[]).map((cat) => {
              const isActive = categoryFilter === cat;
              const label = cat === "all" ? "All" : CATEGORY_LABELS[cat];
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  aria-pressed={isActive}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                    isActive
                      ? "bg-ballot-ink text-clear-ballot"
                      : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Format filter */}
      {polls && polls.length > 0 && !configUnavailable && !errorMessage && (
        <div className="mb-4">
          <div className="sr-only" id="format-filter-label">Filter by participation format</div>
          <div
            role="group"
            aria-labelledby="format-filter-label"
            className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1"
          >
            {(["all", ...POLL_FORMATS] as FormatFilter[]).map((fmt) => {
              const isActive = formatFilter === fmt;
              const label = fmt === "all" ? "All formats" : FORMAT_LABELS[fmt];
              return (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setFormatFilter(fmt)}
                  aria-pressed={isActive}
                  className={`shrink-0 rounded-full px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                    isActive
                      ? "bg-ballot-ink text-clear-ballot"
                      : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Content */}
      {renderContent()}
    </ProductShell>
  );
}
