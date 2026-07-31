import type { PollView, VoteUiState } from "@/types/poll";
import { PollHeader } from "@/components/poll/PollHeader";
import { PollSupportDetails } from "@/components/poll/PollSupportDetails";
import { PollChoiceList } from "@/components/poll/PollChoiceList";
import { PollVotePanel } from "@/components/poll/PollVotePanel";
import { PollResultPanel } from "@/components/poll/PollResultPanel";
import { PollClosedState } from "@/components/poll/PollClosedState";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollPageViewProps {
  poll: PollView;
  voteState: VoteUiState;
  onSelectOption?: (optionId: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * PollPageView is the master assembly component for the full poll page.
 * It composes all sub-components based on the poll's status, results
 * availability, and the current voting state.
 *
 * Rendering hierarchy (as specified in DESIGN.md):
 *   1. PollHeader
 *   2. PollSupportDetails (only if not voted and poll is live)
 *   3. PollChoiceList (with results if poll is closed or has voted)
 *   4. PollVotePanel (if poll is live — covers all vote lifecycle states)
 *   5. PollResultPanel (if results exist and poll is not closed —
 *                      closed polls show results via PollClosedState)
 *   6. PollClosedState (if poll is closed)
 */
export function PollPageView({
  poll,
  voteState,
  onSelectOption,
  className = "",
}: PollPageViewProps) {
  const { status, hasVoted } = poll;
  const isLive = status === "live";
  const isClosed = status === "closed";
  const isCancelled = status === "cancelled";

  // PollClosedState already includes PollResultPanel, so only render
  // PollResultPanel standalone when the poll is live and results exist.
  const hasStandaloneResults =
    poll.results && !isClosed;

  // Show results in the choice list when the poll is closed or the
  // current user has already voted.
  const showChoiceResults = isClosed || (hasVoted ?? false);

  return (
    <div className={`space-y-6 ${className}`}>
      {/* 1. PollHeader — always rendered */}
      <PollHeader
        question={poll.question}
        context={poll.context}
        status={poll.status}
        closingAt={poll.closingAt}
      />

      {/* 2. PollSupportDetails — only when the poll is live and user hasn't voted yet */}
      {isLive && !hasVoted && (
        <PollSupportDetails
          destinationPurpose={poll.destinationPurpose}
          destinationWallet={poll.destinationWallet}
          contributionMode={poll.contributionMode}
          minimumNim={poll.minimumNim}
        />
      )}

      {/* 3. PollChoiceList — always render (it's the core interaction) */}
      <PollChoiceList
        options={poll.options}
        selectedOptionId={
          voteState.selectedOptionId ?? poll.selectedOptionId
        }
        onSelect={onSelectOption}
        showResults={showChoiceResults}
        disabled={!isLive}
        leadingOptionId={poll.results?.leadingOptionId}
      />

      {/* 4. PollVotePanel — only render for live polls, covers all vote states */}
      {isLive && (
        <PollVotePanel
          voteStatus={voteState.status}
          hasVoted={hasVoted}
          selectedOptionId={
            voteState.selectedOptionId ?? poll.selectedOptionId
          }
        />
      )}

      {/* 5. PollResultPanel — standalone when live with results (closed polls get it via PollClosedState) */}
      {hasStandaloneResults && (
        <PollResultPanel results={poll.results!} />
      )}

      {/* 6. PollClosedState — only when poll is closed */}
      {isClosed && (
        <PollClosedState
          results={poll.results}
          closingAt={poll.closingAt}
        />
      )}

      {/* Cancelled state edge case: show a brief message */}
      {isCancelled && (
        <p className="text-body text-reject-red text-center italic">
          This poll has been cancelled. No signals were recorded.
        </p>
      )}
    </div>
  );
}
