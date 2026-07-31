"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { PollView } from "@/types/poll";
import { ProductShell } from "@/components/layout/ProductShell";
import { UnavailableState } from "@/components/state/UnavailableState";
import { ErrorState } from "@/components/state/ErrorState";
import { EmptyState } from "@/components/state/EmptyState";
import { LoadingState } from "@/components/state/LoadingState";
import { ExploreToolbar } from "@/components/explore/ExploreToolbar";
import { PollCard } from "@/components/product/PollCard";
import { Card } from "@/components/ui/Card";
import { ArrowUpRightIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExploreClientProps {
  /** The list of public polls from the data layer, or null when unavailable. */
  polls: PollView[] | null;
  /** Whether Supabase is not configured (env vars missing). */
  configUnavailable: boolean;
  /** A conservative error message from the data layer, or null. */
  errorMessage: string | null;
  /** Whether the parent server component is still fetching data. */
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const goldPillLinkClasses =
  "inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

// ---------------------------------------------------------------------------
// Inline SVG icon for empty state
// ---------------------------------------------------------------------------

function EmptyBallotIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="6"
        y="10"
        width="36"
        height="34"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="20"
        y="4"
        width="8"
        height="6"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="14"
        y="18"
        width="20"
        height="16"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <line
        x1="18"
        y1="23"
        x2="30"
        y2="23"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <line
        x1="18"
        y1="27"
        x2="26"
        y2="27"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExploreClient({
  polls,
  configUnavailable,
  errorMessage,
  isLoading = false,
}: ExploreClientProps) {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "closed"
  >("all");
  const [sortBy, setSortBy] = useState<"recent" | "closing">("recent");

  // -----------------------------------------------------------------------
  // Derive filtered & sorted polls client-side
  // -----------------------------------------------------------------------

  const filteredPolls = useMemo(() => {
    if (!polls || polls.length === 0) return [];

    let results = [...polls];

    // Search: match against question and context (if available)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      results = results.filter((poll) => {
        const questionMatch = poll.question.toLowerCase().includes(q);
        const contextMatch =
          poll.context?.toLowerCase().includes(q) ?? false;
        return questionMatch || contextMatch;
      });
    }

    // Status filter: "active" → "live", "closed" → "closed"
    if (statusFilter !== "all") {
      const targetStatus = statusFilter === "active" ? "live" : "closed";
      results = results.filter((poll) => poll.status === targetStatus);
    }

    // Sort: "recent" = newest first, "closing" = closest deadline first
    if (sortBy === "recent") {
      results.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } else {
      results.sort(
        (a, b) =>
          new Date(a.closingAt).getTime() - new Date(b.closingAt).getTime(),
      );
    }

    return results;
  }, [polls, searchQuery, statusFilter, sortBy]);

  // -----------------------------------------------------------------------
  // Render the content area below the always-visible page header
  // -----------------------------------------------------------------------

  function renderContent() {
    // 0. Still loading — parent server component is fetching
    if (isLoading) {
      return (
        <LoadingState variant="list" count={3} />
      );
    }

    // 1. Supabase not configured — missing env vars
    if (configUnavailable) {
      return (
        <UnavailableState
          title="Public poll data is not connected"
          description="The Supabase database hasn't been configured yet. Public poll data will appear here once the Votum data layer is connected."
        />
      );
    }

    // 2. Fetch error — something went wrong on the server
    if (errorMessage) {
      return (
        <ErrorState
          title="Could not load public polls"
          description="Something went wrong while fetching public polls. Please try again."
          onRetry={() => window.location.reload()}
        />
      );
    }

    // 3. Empty — connected but no public polls exist yet
    if (polls && polls.length === 0) {
      return (
        <EmptyState
          icon={<EmptyBallotIcon className="w-12 h-12" />}
          title="No public polls to explore yet."
          description="Public polls will appear here once they are available. Create the first Votum Poll and invite your community to put NIM behind a decision."
          action={
            <div className="flex flex-col gap-3">
              <Link href="/create" className={goldPillLinkClasses}>
                Create a Votum Poll
              </Link>
              <Link
                href="/how-it-works"
                className="text-body text-quiet-ink hover:text-ballot-ink transition-colors"
              >
                See how Votum works
              </Link>
            </div>
          }
        />
      );
    }

    // 4. Populated — show toolbar + poll cards with local filter/sort
    if (polls && polls.length > 0) {
      return (
        <>
          {/* Discovery toolbar */}
          <Card glass className="mb-6 p-3 sm:p-4">
            <ExploreToolbar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              statusFilter={statusFilter}
              onStatusChange={setStatusFilter}
              sortBy={sortBy}
              onSortChange={(value) => {
                // Only "recent" and "closing" are valid sort options.
                // "Most participated" is no longer supported; if the
                // toolbar emits it (the Select still lists it), ignore.
                if (value === "recent" || value === "closing") {
                  setSortBy(value);
                }
              }}
            />
          </Card>

          {/* Poll cards or filtered-empty message */}
          {filteredPolls.length > 0 ? (
            <div className="space-y-4">
              {filteredPolls.map((poll) => (
                <PollCard
                  key={poll.id}
                  question={poll.question}
                  optionCount={poll.options.length}
                  status={poll.status}
                  href={`/polls/${poll.id}`}
                />
              ))}
            </div>
          ) : (
            <p className="text-body text-quiet-ink text-center py-12">
              No polls match your current filters.
            </p>
          )}
        </>
      );
    }

    // Fallback — should be unreachable given the page.tsx guarantees
    return null;
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <ProductShell>
      {/* Page header — always visible regardless of state */}
      <Card glass className="mb-6 p-6 sm:p-8">
        <div className="flex items-center gap-1.5 text-micro text-quiet-ink tracking-wider mb-2">
          <ArrowUpRightIcon className="flex-shrink-0" />
          PUBLIC VOTUM POLLS
        </div>

        <h1 className="max-w-[520px] text-page-title font-display text-ballot-ink">
          Explore community decisions.
        </h1>

        <p className="text-body text-quiet-ink mt-3 max-w-prose">
          Public Votum Polls let communities make decisions with NIM-backed
          votes. See what people are choosing and what they care enough to
          support.
        </p>

        <div className="mt-6">
          <Link href="/create" className={goldPillLinkClasses}>
            Create a Votum Poll
          </Link>
        </div>
      </Card>

      {/* State-dependent content */}
      {renderContent()}
    </ProductShell>
  );
}
