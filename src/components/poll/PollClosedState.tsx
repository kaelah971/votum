import type { PollResultView } from "@/types/poll";
import { PollResultPanel } from "@/components/poll/PollResultPanel";
import { formatClosingTime } from "@/lib/format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollClosedStateProps {
  results?: PollResultView;
  closingAt?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollClosedState({
  results,
  closingAt,
  className = "",
}: PollClosedStateProps) {
  return (
    <div className={`space-y-6 ${className}`}>
      {/* Closed heading — never says the winning option receives NIM */}
      <div className="text-center space-y-2">
        <h2 className="text-card-heading font-display text-ballot-ink">
          The community has spoken—with support behind it.
        </h2>

        {closingAt && (
          <p className="text-micro text-quiet-ink">
            Closed {formatClosingTime(new Date(closingAt))}
          </p>
        )}
      </div>

      {/* Final results — delegating to PollResultPanel */}
      {results && <PollResultPanel results={results} />}

      {/* No results yet edge case */}
      {!results && (
        <p className="text-body text-quiet-ink text-center">
          No verified signals were recorded for this poll.
        </p>
      )}
    </div>
  );
}
