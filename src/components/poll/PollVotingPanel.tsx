"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { PollView } from "@/types/poll";
import { PollHeader } from "@/components/poll/PollHeader";
import { PollSupportDetails } from "@/components/poll/PollSupportDetails";
import { PollChoiceList } from "@/components/poll/PollChoiceList";
import { PollClosedState } from "@/components/poll/PollClosedState";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useOnboarding } from "@/providers/OnboardingProvider";

// ---------------------------------------------------------------------------
// API response shapes (matching the real API contracts)
// ---------------------------------------------------------------------------

interface ResultsData {
  pollId: string;
  status: string;
  endsAt: string;
  totalVotes: number;
  options: Array<{ optionId: string; label: string; voteCount: number }>;
}

interface UserVoteData {
  voted: boolean;
  vote?: { id: string; optionId: string; createdAt: string };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollVotingPanelProps {
  poll: PollView;
  className?: string;
}

// ---------------------------------------------------------------------------
// Inline SVG icon
// ---------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="flex-shrink-0"
    >
      <path
        d="M13.5 4.5L6 12L2.5 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PollVotingPanel({
  poll,
  className = "",
}: PollVotingPanelProps) {
  const { walletStatus } = useNimiqContext();
  const { isSessionVerified, isWalletMatched } =
    useVotumSession();
  const { openOnboarding } = useOnboarding();
  const pathname = usePathname();

  // ----- Client-side state -----
  const [results, setResults] = useState<ResultsData | null>(null);
  const [userVote, setUserVote] = useState<UserVoteData | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedVote, setConfirmedVote] = useState<{
    id: string;
    optionId: string;
    createdAt: string;
  } | null>(null);


  // ----- Derived flags -----
  const isLive = poll.status === "live";
  const isClosed = poll.status === "closed";
  const hasVoted = userVote?.voted === true || confirmedVote !== null;

  // ----- Data fetching -----

  /**
   * Load public results — does NOT require a verified session.
   */
  const loadResults = useCallback(async () => {
    try {
      const res = await fetch(`/api/polls/${poll.id}/results`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.ok) setResults(await res.json());
    } catch {
      // Non-critical — results refresh on next trigger.
    }
  }, [poll.id]);

  /**
   * Load the current user's vote — requires a verified session.
   * Called automatically when the session becomes verified.
   */
  const loadUserVote = useCallback(async () => {
    try {
      const res = await fetch(`/api/polls/${poll.id}/vote`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.ok) {
        const data: UserVoteData = await res.json();
        setUserVote(data);
        if (data.voted && data.vote) {
          setSelectedOptionId(data.vote.optionId);
          setConfirmedVote(data.vote);
        }
      }
    } catch {
      // Will retry when the session connects or the component remounts.
    }
  }, [poll.id]);

  // Load results on mount and whenever the poll id changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadResults();
  }, [loadResults]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isSessionVerified) loadUserVote();
  }, [isSessionVerified, loadUserVote]);

  // ----- Vote casting -----

  const handleCastVote = useCallback(async () => {
    if (!selectedOptionId || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/polls/${poll.id}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ optionId: selectedOptionId }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setConfirmedVote(data.vote);
        setSubmitting(false);
        loadUserVote();
        loadResults();
        return;
      }

      if (res.status === 409) {
        setError("You already voted in this poll.");
        loadUserVote();
        loadResults();
      } else if (res.status === 401) {
        setError(
          "Your verified wallet session has expired. Verify your wallet again to vote.",
        );
      } else if (res.status === 423 || res.status === 404) {
        setError("This poll is no longer accepting votes.");
      } else {
        setError(
          (data.message as string) ??
            "Votum could not record your vote. Try again.",
        );
      }
    } catch {
      setError("Votum could not reach the voting service. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, [selectedOptionId, submitting, poll.id, loadUserVote, loadResults]);

  // ----- Eligibility -----

  // True when voting is blocked only by missing wallet verification
  // (an option must be chosen first so the intent resumes the real action).
  const needsOnboarding =
    isLive &&
    selectedOptionId !== null &&
    !hasVoted &&
    !submitting &&
    (!isSessionVerified || !isWalletMatched);

  const canVote =
    isLive &&
    selectedOptionId !== null &&
    isSessionVerified &&
    isWalletMatched &&
    !hasVoted &&
    !submitting;

  const eligibilityHint = (() => {
    if (hasVoted) return null;
    if (!isLive) return isClosed ? "This poll is closed." : null;
    if (walletStatus !== "connected")
      return "Connect your Nimiq wallet to vote.";
    if (!isSessionVerified) return "Verify wallet ownership to vote.";
    if (!isWalletMatched)
      return "The connected wallet does not match the verified wallet.";
    return null;
  })();

  // ----- Vote gate: open onboarding with the vote intent, never auto-submit -----

  const handleVoteClick = useCallback(() => {
    if (submitting) return;
    if (!isSessionVerified || !isWalletMatched) {
      openOnboarding({ intent: "vote", returnPath: pathname });
      return;
    }
    void handleCastVote();
  }, [submitting, isSessionVerified, isWalletMatched, openOnboarding, pathname, handleCastVote]);

  // ----- Render -----

  return (
    <div className={`space-y-6 ${className}`}>
      {/* 1. Poll header */}
      <PollHeader
        question={poll.question}
        context={poll.context}
        status={poll.status}
        closingAt={poll.closingAt}
        category={poll.category}
        format={poll.format}
      />

      {/* 2. Support details — only for live polls where the user hasn't voted */}
      {isLive && !hasVoted && (
        <PollSupportDetails
          destinationPurpose={poll.destinationPurpose}
          destinationWallet={poll.destinationWallet}
          contributionMode={poll.contributionMode}
          minimumNim={poll.minimumNim}
        />
      )}

      {/* 3. Poll options */}
      <PollChoiceList
        options={poll.options}
        selectedOptionId={
          confirmedVote?.optionId ?? selectedOptionId ?? undefined
        }
        onSelect={hasVoted ? undefined : setSelectedOptionId}
        showResults={hasVoted || isClosed}
        disabled={!isLive || hasVoted}
      />

      {/* 4. Voting action section — only for live polls */}
      {isLive && (
        <div className="space-y-4">
          <Card className="p-5 space-y-4">
            <FairnessLabel />

            <p className="text-secondary text-quiet-ink">
              NIM contribution is displayed as a separate support signal.
              Contributing more NIM does not create additional votes.
            </p>

            {/* Confirmed vote acknowledgement */}
            {confirmedVote && (
              <div className="rounded-card bg-verified-green/[0.06] border border-verified-green/20 p-4 space-y-2">
                <p className="text-body font-medium text-verified-green flex items-center gap-1.5">
                  <CheckIcon />
                  Vote confirmed
                </p>
                <p className="text-sm text-ballot-ink">
                  {poll.options.find((o) => o.id === confirmedVote.optionId)
                    ?.label ?? "Your choice"}
                </p>
                <p className="text-micro text-quiet-ink">
                  {new Date(confirmedVote.createdAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {" · "}One wallet · one vote
                </p>
              </div>
            )}

            {/* Vote button + eligibility hint — hidden after confirmation */}
            {!confirmedVote && (
              <>
                <Button
                  type="button"
                  variant="primary"
                  disabled={!canVote && !needsOnboarding}
                  onClick={handleVoteClick}
                  className="w-full"
                >
                  {submitting
                    ? "Recording vote…"
                    : needsOnboarding
                      ? walletStatus === "connected"
                        ? "Verify wallet ownership to vote"
                        : "Connect wallet to vote"
                      : "Cast vote"}
                </Button>

                {eligibilityHint && !submitting && (
                  <p className="text-micro text-quiet-ink text-center">
                    {eligibilityHint}
                  </p>
                )}
              </>
            )}

            {error && (
              <p className="text-micro text-reject-red text-center" role="alert">
                {error}
              </p>
            )}
          </Card>
        </div>
      )}

      {/* 5. Results section — public, always shown when available */}
      {results && (
        <div className="space-y-3">
          <h3 className="text-card-heading font-display text-ballot-ink">
            Results
          </h3>
          <Card className="p-5 space-y-3">
            {results.totalVotes === 0 ? (
              <p className="text-body text-quiet-ink text-center py-4">
                No votes yet. Be the first to back a choice.
              </p>
            ) : (
              <>
                <div className="space-y-3">
                  {results.options.map((opt) => {
                    const pct =
                      results.totalVotes > 0
                        ? Math.round(
                            (opt.voteCount / results.totalVotes) * 100,
                          )
                        : 0;
                    return (
                      <div key={opt.optionId} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-ballot-ink">
                            {opt.label}
                          </span>
                          <span className="text-micro text-quiet-ink">
                            {opt.voteCount} vote
                            {opt.voteCount !== 1 ? "s" : ""} · {pct}%
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-soft-fog overflow-hidden">
                          <div
                            className="h-full rounded-full bg-nim-blue transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-micro text-quiet-ink text-center pt-2">
                  {results.totalVotes} total vote
                  {results.totalVotes !== 1 ? "s" : ""}
                </p>
              </>
            )}
          </Card>
          {/* NIM support placeholder — communicates future integration */}
          <p className="text-micro text-quiet-ink text-center">
            NIM support will be confirmed separately from your vote.
          </p>
        </div>
      )}

      {/* 6. Closed state — only when the poll is closed */}
      {isClosed && (
        <PollClosedState
          results={poll.results ?? undefined}
          closingAt={poll.closingAt}
        />
      )}
    </div>
  );
}
