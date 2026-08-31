import type { PollResultView, PollView } from "@/types/poll";
import { PollResultPanel } from "@/components/poll/PollResultPanel";
import { formatClosingTime } from "@/lib/format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollClosedStateProps {
  results?: PollResultView;
  economicModel: PollView["economicModel"];
  closingAt?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollClosedState({
  results,
  economicModel,
  closingAt,
  className = "",
}: PollClosedStateProps) {
  const isLegacySupport = economicModel === "legacy_support";

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Closed heading — reward-first polls never imply participant support. */}
      <div className="text-center space-y-2">
        <h2 className="text-card-heading font-display text-ballot-ink">
          {isLegacySupport
            ? "The community has spoken—with legacy support shown separately."
            : "The community has spoken."}
        </h2>

        {closingAt && (
          <p className="text-micro text-quiet-ink">
            Closed {formatClosingTime(new Date(closingAt))}
          </p>
        )}
      </div>

      {/* Final results — delegating to PollResultPanel */}
      {results && (
        <PollResultPanel results={results} economicModel={economicModel} />
      )}

      {/* No results yet edge case */}
      {!results && (
        <p className="text-body text-quiet-ink text-center">
          No verified votes were recorded for this poll.
        </p>
      )}
    </div>
  );
}
