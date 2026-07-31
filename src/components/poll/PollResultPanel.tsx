import type { PollResultView } from "@/types/poll";
import { Card } from "@/components/ui/Card";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollResultPanelProps {
  results: PollResultView;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollResultPanel({
  results,
  className = "",
}: PollResultPanelProps) {
  const { options, totalWallets, totalNim, isFinal } = results;

  // Edge case: no results data yet
  if (options.length === 0) {
    return (
      <Card className={`p-6 ${className}`}>
        <p className="text-body text-quiet-ink text-center">
          No verified signals yet. Be the first to back a choice.
        </p>
      </Card>
    );
  }

  return (
    <Card className={`p-6 space-y-5 ${className}`}>
      {/* Results heading */}
      <h3 className="text-card-heading font-display text-ballot-ink">
        {isFinal ? "Final results" : "Results so far"}
      </h3>

      {/* Per-option result rows */}
      <ul className="space-y-4">
        {options.map((option) => (
          <li key={option.id} className="space-y-2">
            {/* Option label */}
            <div className="flex items-center justify-between">
              <span className="text-body font-medium text-ballot-ink">
                {option.label}
              </span>

              {/* Percentage badge — wallet participation only */}
              {option.percentage !== undefined && (
                <span className="text-micro text-quiet-ink">
                  {option.percentage}%
                </span>
              )}
            </div>

            {/* Stats: wallet count (bold) + NIM signalled (proof/nim-blue) */}
            <div className="flex items-center gap-3">
              {option.walletCount !== undefined && (
                <span className="text-body font-semibold text-ballot-ink">
                  {option.walletCount.toLocaleString()} wallet
                  {option.walletCount !== 1 ? "s" : ""}
                </span>
              )}
              {option.nimSignalled !== undefined && (
                <span className="text-proof text-nim-blue">
                  {option.nimSignalled.toLocaleString()} NIM
                </span>
              )}
            </div>

            {/* Percentage bar — represents wallet participation only, nim-blue */}
            {option.percentage !== undefined && (
              <div className="w-full h-2 rounded-full bg-soft-fog overflow-hidden">
                <div
                  className="h-full rounded-full bg-nim-blue transition-all"
                  style={{ width: `${Math.min(option.percentage, 100)}%` }}
                  role="progressbar"
                  aria-valuenow={option.percentage}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${option.label}: ${option.percentage}% of wallets`}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Totals row */}
      <div className="pt-3 border-t border-divider">
        <div className="flex flex-wrap items-center gap-4">
          {totalWallets !== undefined && (
            <span className="text-secondary text-ballot-ink">
              {totalWallets.toLocaleString()} total wallet
              {totalWallets !== 1 ? "s" : ""}
            </span>
          )}
          {totalNim !== undefined && (
            <span className="text-proof text-nim-blue">
              {totalNim.toLocaleString()} NIM contributed
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
