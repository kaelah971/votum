"use client";

import { useState } from "react";
import Link from "next/link";
import type { CreatorPollSummary, PollStatus } from "@/types/poll";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { WalletButton } from "@/components/ui/WalletButton";
import { LoadingState } from "@/components/state/LoadingState";
import { EmptyState } from "@/components/state/EmptyState";
import { ErrorState } from "@/components/state/ErrorState";
import { WalletIconLarge } from "@/components/ui/icons";
import { formatDate, formatClosingTime } from "@/lib/format";

interface MyPollsViewProps {
  polls: CreatorPollSummary[] | null;
  walletConnected: boolean;
  isLoading?: boolean;
  error?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Array<{ value: PollStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "closed", label: "Closed" },
  { value: "draft", label: "Draft" },
];

const statusBadgeVariant: Record<PollStatus, "signal" | "default" | "verified" | "reject"> =
  {
    live: "signal",
    draft: "default",
    closed: "default",
    cancelled: "reject",
  };

const statusLabel: Record<PollStatus, string> = {
  live: "Live",
  draft: "Draft",
  closed: "Closed",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MyPollsView({
  polls,
  walletConnected,
  isLoading = false,
  error,
  className = "",
}: MyPollsViewProps) {
  const [statusFilter, setStatusFilter] = useState<PollStatus | "all">("all");

  // ---- State: no wallet connected ----
  if (!walletConnected) {
    return (
      <div
        className={`flex flex-col items-center justify-center py-16 px-5 w-full max-w-md mx-auto ${className}`}
      >
        <div className="mb-6 text-signal-gold opacity-80">
          <WalletIconLarge />
        </div>
        <h2 className="text-section-heading font-display text-ballot-ink text-center">
          Your community decisions live here.
        </h2>
        <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
          Connect your Nimiq Pay wallet to view the Votum Polls created by this
          wallet.
        </p>
        <div className="mt-8">
          <WalletButton />
        </div>
      </div>
    );
  }

  // ---- State: loading ----
  if (isLoading) {
    return <LoadingState variant="list" count={3} className={className} />;
  }

  // ---- State: error ----
  if (error) {
    return (
      <ErrorState
        title="Could not load your polls"
        description={error}
        onRetry={undefined}
        className={className}
      />
    );
  }

  // ---- State: null (no data yet — no polls fetched) ----
  if (polls === null) {
    return null;
  }

  // ---- State: empty list ----
  if (polls.length === 0) {
    return (
      <EmptyState
        title="You have not created a Votum Poll yet."
        description="Polls you create will appear here so you can track contributions, view results, and share them with your community."
        action={
          <Link
            href="/create"
            className="inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2"
          >
            Create a Votum Poll
          </Link>
        }
        className={className}
      />
    );
  }

  // ---- Filter polls ----
  const filteredPolls =
    statusFilter === "all"
      ? polls
      : polls.filter((p) => p.status === statusFilter);

  return (
    <div className={className}>
      {/* ---- Filter toolbar ---- */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTERS.map((filter) => {
          const isActive = statusFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                isActive
                  ? "bg-ballot-ink text-clear-ballot"
                  : "bg-clear-ballot text-quiet-ink border border-border hover:bg-soft-fog"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {/* ---- Poll cards grid ---- */}
      {filteredPolls.length === 0 ? (
        <p className="text-body text-quiet-ink text-center py-8">
          No polls match this filter.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredPolls.map((poll) => (
            <Link
              key={poll.id}
              href={`/my-polls/${poll.id}`}
              className="block"
            >
              <Card className="p-5 space-y-3 hover:shadow-card transition-shadow h-full">
                {/* Question */}
                <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
                  {poll.question}
                </h3>

                {/* Status badge */}
                <div>
                  <Badge variant={statusBadgeVariant[poll.status]}>
                    {statusLabel[poll.status]}
                  </Badge>
                </div>

                {/* Created time */}
                <p className="text-micro text-quiet-ink">
                  Created {formatDate(new Date(poll.createdAt))}
                </p>

                {/* Closing time */}
                {poll.closingAt && (
                  <p className="text-micro text-fairness-amber">
                    Closes {formatClosingTime(new Date(poll.closingAt))}
                  </p>
                )}

                {/* Wallet count + NIM signalled */}
                {(poll.totalWallets !== undefined ||
                  poll.totalNim !== undefined) && (
                  <div className="flex flex-wrap items-center gap-3">
                    {poll.totalWallets !== undefined && (
                      <span className="text-proof text-nim-blue">
                        {poll.totalWallets.toLocaleString()} wallet
                        {poll.totalWallets !== 1 ? "s" : ""}
                      </span>
                    )}
                    {poll.totalNim !== undefined && (
                      <span className="text-proof text-nim-blue">
                        {poll.totalNim.toLocaleString()} NIM
                      </span>
                    )}
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
