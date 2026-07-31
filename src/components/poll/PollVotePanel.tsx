import type { VoteStatus } from "@/types/poll";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { WalletButton } from "@/components/ui/WalletButton";
import { CheckIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Inline SVG icon components
// ---------------------------------------------------------------------------

/** Spinner-like indeterminate progress indicator for verifying state. */
function VerifyingSpinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="animate-spin text-nim-blue flex-shrink-0"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="9 30"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollVotePanelProps {
  voteStatus: VoteStatus;
  hasVoted?: boolean;
  selectedOptionId?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollVotePanel({
  voteStatus,
  selectedOptionId,
  className = "",
}: PollVotePanelProps) {

  return (
    <Card className={`p-6 space-y-5 ${className}`}>
      {/* Fairness rule — always shown above the vote area */}
      <FairnessLabel />

      {/* Contextual message below the fairness label */}
      <p className="text-micro text-quiet-ink">
        NIM contribution is displayed as a separate support signal. Contributing
        more NIM does not create additional votes.
      </p>

      {/* ================================================================ */}
      {/* Vote-status-specific content                                     */}
      {/* ================================================================ */}

      {voteStatus === "idle" && (
        <p className="text-body text-quiet-ink">
          Choose an option to continue.
        </p>
      )}

      {voteStatus === "option_selected" && (
        <div className="space-y-3">
          <Button variant="primary" size="md" disabled>
            Back this choice with NIM
          </Button>
          <p className="text-micro text-quiet-ink">
            NIM payment confirmation will be enabled during product integration.
          </p>
        </div>
      )}

      {voteStatus === "wallet_required" && (
        <div className="space-y-3">
          <WalletButton />
          <p className="text-body text-quiet-ink">
            Connect your Nimiq wallet to back a choice with NIM.
          </p>
        </div>
      )}

      {voteStatus === "awaiting_confirmation" && (
        <div className="flex items-center gap-2">
          <VerifyingSpinner />
          <p className="text-body text-nim-blue">
            Confirm your NIM contribution in Nimiq Pay.
          </p>
        </div>
      )}

      {voteStatus === "verifying" && (
        <div className="flex items-center gap-2">
          <VerifyingSpinner />
          <p className="text-body text-quiet-ink">
            Confirming your contribution and recording your signal.
          </p>
        </div>
      )}

      {voteStatus === "verified" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckIcon className="text-verified-green flex-shrink-0" />
            <span className="text-body text-verified-green font-medium">
              Your signal is verified.
            </span>
          </div>
          {selectedOptionId && (
            <p className="text-secondary text-quiet-ink">
              Your choice has been recorded.
            </p>
          )}
        </div>
      )}

      {voteStatus === "cancelled" && (
        <p className="text-body text-reject-red">
          No vote was recorded. Your payment was not confirmed.
        </p>
      )}

      {voteStatus === "failed" && (
        <p className="text-body text-reject-red">
          No vote was recorded. Please try again.
        </p>
      )}

      {voteStatus === "already_voted" && (
        <div className="flex items-center gap-2">
          <CheckIcon className="text-verified-green flex-shrink-0" />
          <span className="text-body text-verified-green font-medium">
            Your NIM-backed signal is recorded.
          </span>
        </div>
      )}

      {voteStatus === "poll_closed" && (
        <p className="text-body text-quiet-ink italic">
          The community has spoken—with support behind it.
        </p>
      )}
    </Card>
  );
}
