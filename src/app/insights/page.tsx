"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/state/ErrorState";
import { EmptyState } from "@/components/state/EmptyState";
import { WalletButton } from "@/components/ui/WalletButton";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useNimiqContext } from "@/providers/NimiqProvider";
import Link from "next/link";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { PollTaxonomyBadges } from "@/components/product/PollTaxonomyBadges";

// ---------------------------------------------------------------------------
// API response types (mirrors GET /api/me/intelligence)
// ---------------------------------------------------------------------------

interface IntelligenceSummary {
  totalPolls: number;
  livePolls: number;
  closedPolls: number;
  totalVotes: number;
  totalNimLuna: string;
  totalContributions: number;
  averageVotesPerPoll: number;
  averageNimLunaPerPoll: string;
}

interface OptionBreakdown {
  optionId: string;
  label: string;
  voteCount: number;
  nimLuna: string;
  contributionCount: number;
}

interface PollPerformance {
  id: string;
  question: string;
  status: string;
  category: PollCategory;
  format: PollFormat;
  createdAt: string;
  endsAt: string | null;
  totalVotes: number;
  totalNimLuna: string;
  contributionCount: number;
  options: OptionBreakdown[];
}

interface ActivityItem {
  id: string;
  type: "poll_published" | "vote_received" | "nim_support_confirmed" | "poll_closed";
  pollId: string;
  pollQuestion: string;
  optionId?: string;
  optionLabel?: string;
  amountLuna?: string;
  occurredAt: string;
}

interface IntelligenceResponse {
  summary: IntelligenceSummary;
  polls: PollPerformance[];
  activity: ActivityItem[];
}

// ---------------------------------------------------------------------------
// State union for the page's fetch lifecycle
// ---------------------------------------------------------------------------

type PageState =
  | { tag: "loading" }
  | { tag: "error"; message: string }
  | { tag: "data"; data: IntelligenceResponse };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Luna amount (as a string) to NIM with up to 5 fractional digits,
 * removing trailing zeros for a clean display.
 * Uses BigInt arithmetic — never parseFloat.
 */
function formatLunaToNimShort(lunaStr: string): string {
  try {
    const luna = BigInt(lunaStr);
    const LUNA_PER_NIM = BigInt(100000);
    const whole = luna / LUNA_PER_NIM;
    const frac = luna % LUNA_PER_NIM;
    if (frac === BigInt(0)) return `${whole} NIM`;
    const fracStr = frac.toString().padStart(5, "0").replace(/0+$/, "");
    return `${whole}.${fracStr} NIM`;
  } catch {
    return "0 NIM";
  }
}

/**
 * Compute the percentage of NIM support an option holds relative to the
 * poll total. Returns 0–100 with up to two decimals.
 * Safe against division by zero.
 */
function safeNimPct(optLuna: string, totalLuna: string): number {
  try {
    const o = BigInt(optLuna);
    const t = BigInt(totalLuna);
    if (t <= BigInt(0)) return 0;
    // basis points → percentage
    return Number((o * BigInt(10000)) / t) / 100;
  } catch {
    return 0;
  }
}

function activityIcon(type: ActivityItem["type"]): ReactNode {
  const cls = "w-4 h-4 text-quiet-ink";
  switch (type) {
    case "poll_published":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2h7l4 4v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" />
          <path d="M10 2v4h4" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "vote_received":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5.5 7.5L7.5 9.5L10.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "nim_support_confirmed":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M10 9h1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      // poll_closed or any unknown type
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// MetricCard — small inline component for the summary grid
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: string;
}) {
  return (
    <Card className="p-4 text-center">
      <p className="text-micro text-quiet-ink">{label}</p>
      <p
        className={`text-card-heading font-display mt-1 ${
          highlight === "live" ? "text-signal-gold" : "text-ballot-ink"
        }`}
      >
        {value}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SkeletonPlaceholder — simple pulse cards shown during loading
// ---------------------------------------------------------------------------

function SkeletonPlaceholder() {
  return (
    <div className="space-y-6">
      {/* Summary skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-card bg-soft-fog h-24" />
        ))}
      </div>
      {/* Poll performance skeleton */}
      <div className="space-y-4">
        <div className="animate-pulse rounded-overlay bg-soft-fog h-8 w-48" />
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-card bg-soft-fog h-40" />
        ))}
      </div>
      {/* Activity skeleton */}
      <div className="space-y-4">
        <div className="animate-pulse rounded-overlay bg-soft-fog h-8 w-40" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-card bg-soft-fog h-16" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function CreatorInsightsPage() {
  const { isSessionVerified } = useVotumSession();
  const { walletStatus } = useNimiqContext();
  const [pageState, setPageState] = useState<PageState>({ tag: "loading" });
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Force a re-fetch (e.g. when the user taps "Refresh insights")
  const refreshInsights = useCallback(() => {
    setFetchTrigger((n) => n + 1);
  }, []);

  // Fetch intelligence data whenever the session state or trigger changes.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Only fetch when the user has a verified session.
      if (!isSessionVerified) {
        if (!cancelled) setPageState({ tag: "loading" });
        return;
      }

      if (!cancelled) setPageState({ tag: "loading" });

      try {
        const res = await fetch("/api/me/intelligence", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            (body as { message?: string }).message ??
            `Unexpected error (${res.status})`;
          if (!cancelled) setPageState({ tag: "error", message: msg });
          return;
        }

        const data: IntelligenceResponse = await res.json();
        if (!cancelled) setPageState({ tag: "data", data });
      } catch (err: unknown) {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : "Failed to load insights";
          setPageState({ tag: "error", message: msg });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [isSessionVerified, fetchTrigger]);

  // ---- Render helpers ----

  function renderContent() {
    // No session — not verified
    if (!isSessionVerified) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-5 w-full max-w-md mx-auto">
          <h2 className="text-section-heading font-display text-ballot-ink text-center">
            Connect and verify your wallet
          </h2>
          <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
            Connect and verify your Nimiq wallet to view creator insights.
          </p>
          <div className="mt-8">
            <WalletButton />
          </div>
        </div>
      );
    }

    // Wallet disconnected — still show wallet prompt
    if (walletStatus !== "connected") {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-5 w-full max-w-md mx-auto">
          <h2 className="text-section-heading font-display text-ballot-ink text-center">
            Connect and verify your wallet
          </h2>
          <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
            Connect and verify your Nimiq wallet to view creator insights.
          </p>
          <div className="mt-8">
            <WalletButton />
          </div>
        </div>
      );
    }

    switch (pageState.tag) {
      case "loading":
        return <SkeletonPlaceholder />;

      case "error":
        return (
          <ErrorState
            title="Could not load insights"
            description={pageState.message}
            onRetry={refreshInsights}
          />
        );

      case "data": {
        const { summary, polls, activity } = pageState.data;

        // Empty state — verified but no polls created yet
        if (summary.totalPolls === 0) {
          return (
            <EmptyState
              title="No creator insights yet"
              description="After you create and publish your first poll, performance insights and activity will appear here."
              action={
                <Link href="/create">
                  <Button variant="primary">Create your first poll</Button>
                </Link>
              }
            />
          );
        }

        return (
          <div className="space-y-8">
            {/* Refresh button */}
            <div className="flex items-center justify-between">
              <h1 className="text-page-title font-display text-ballot-ink">
                Creator insights
              </h1>
              <Button variant="secondary" size="sm" onClick={refreshInsights}>
                Refresh insights
              </Button>
            </div>

            {/* ============================================================= */}
            {/* Summary Metrics                                                */}
            {/* ============================================================= */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard label="Total polls" value={summary.totalPolls} />
              <MetricCard label="Live" value={summary.livePolls} highlight="live" />
              <MetricCard label="Closed" value={summary.closedPolls} />
              <MetricCard label="Total votes" value={summary.totalVotes} />
              <MetricCard
                label="Confirmed NIM"
                value={formatLunaToNimShort(summary.totalNimLuna)}
              />
              <MetricCard
                label="Confirmed supports"
                value={summary.totalContributions}
              />
            </div>

            {/* ============================================================= */}
            {/* Poll Performance                                               */}
            {/* ============================================================= */}
            <div className="space-y-4">
              <h2 className="text-section-heading font-display text-ballot-ink">
                Poll Performance
              </h2>
              {polls.length === 0 ? (
                <p className="text-body text-quiet-ink">
                  No poll data available yet.
                </p>
              ) : (
                polls.map((poll) => (
                  <Card key={poll.id} className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
                          {poll.question}
                        </h3>
                        <div className="mt-1.5">
                          <PollTaxonomyBadges
                            category={poll.category}
                            format={poll.format}
                            size="sm"
                          />
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-micro text-quiet-ink flex-wrap">
                          <span
                            className={`rounded-full px-2.5 py-0.5 font-medium ${
                              poll.status === "live"
                                ? "bg-signal-gold/10 text-deep-gold"
                                : "bg-soft-fog text-quiet-ink"
                            }`}
                          >
                            {poll.status}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {poll.totalVotes} vote{poll.totalVotes !== 1 ? "s" : ""}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {formatLunaToNimShort(poll.totalNimLuna)} NIM
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {poll.contributionCount} support
                            {poll.contributionCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                      <Link
                        href={`/polls/${poll.id}`}
                        className="text-sm text-nim-blue hover:text-signal-gold transition-colors flex-shrink-0"
                      >
                        View poll
                      </Link>
                    </div>

                    {/* Option breakdown */}
                    <div className="space-y-2 pt-2 border-t border-divider">
                      {poll.options.map((opt) => {
                        const votePct =
                          poll.totalVotes > 0
                            ? Math.round((opt.voteCount / poll.totalVotes) * 100)
                            : 0;
                        const nimPct = safeNimPct(opt.nimLuna, poll.totalNimLuna);
                        return (
                          <div key={opt.optionId} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-ballot-ink">{opt.label}</span>
                              <span className="text-micro text-quiet-ink">
                                {opt.voteCount} vote{opt.voteCount !== 1 ? "s" : ""}
                                {" · "}
                                {formatLunaToNimShort(opt.nimLuna)} NIM
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-soft-fog overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-nim-blue transition-all"
                                  style={{ width: `${votePct}%` }}
                                />
                              </div>
                              <div className="flex-1 h-1.5 rounded-full bg-soft-fog overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-signal-gold transition-all"
                                  style={{ width: `${nimPct}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <p className="text-micro text-quiet-ink pt-1">
                         Blue = votes · Gold = legacy NIM support
                      </p>
                    </div>
                  </Card>
                ))
              )}
            </div>

            {/* ============================================================= */}
            {/* Recent Activity                                                */}
            {/* ============================================================= */}
            <div className="space-y-4">
              <h2 className="text-section-heading font-display text-ballot-ink">
                Recent Activity
              </h2>
              {activity.length === 0 ? (
                <p className="text-body text-quiet-ink">
                  No recent activity to show.
                </p>
              ) : (
                activity.slice(0, 20).map((item) => (
                  <Link
                    key={item.id}
                    href={`/polls/${item.pollId}`}
                    className="block"
                  >
                    <Card className="p-4 hover:shadow-card transition-shadow">
                      <div className="flex items-start gap-3">
                        <span className="flex-shrink-0 mt-0.5">
                          {activityIcon(item.type)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-ballot-ink">
                            {item.type === "poll_published" &&
                              `Published "${item.pollQuestion}"`}
                            {item.type === "vote_received" &&
                              `A vote was received for "${item.optionLabel}"`}
                            {item.type === "nim_support_confirmed" &&
                               `${formatLunaToNimShort(item.amountLuna ?? "0")} legacy NIM support was confirmed for "${item.optionLabel}"`}
                            {item.type === "poll_closed" &&
                              `"${item.pollQuestion}" closed`}
                          </p>
                          <p className="text-micro text-quiet-ink mt-0.5">
                            {new Date(item.occurredAt).toLocaleDateString(
                              "en-US",
                              {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              },
                            )}
                          </p>
                        </div>
                      </div>
                    </Card>
                  </Link>
                ))
              )}
            </div>
          </div>
        );
      }
    }
  }

  return <ProductShell>{renderContent()}</ProductShell>;
}
