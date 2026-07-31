interface PollOptionProps {
  label: string;
  description?: string;
  selected?: boolean;
  walletCount?: number;
  nimAmount?: number;
  percentage?: number;
  showResults?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function PollOption({
  label,
  description,
  selected = false,
  walletCount,
  nimAmount,
  percentage,
  showResults = false,
  disabled = false,
  onClick,
  className = "",
}: PollOptionProps) {
  const isInteractive = !!onClick && !disabled;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left border border-border rounded-card p-4 min-h-[44px] transition-colors
        ${selected ? "border-signal-gold bg-signal-gold/[0.04]" : "bg-clear-ballot"}
        ${disabled ? "opacity-50 pointer-events-none" : ""}
        ${isInteractive ? "cursor-pointer hover:border-signal-gold/50" : "cursor-default"}
        ${className}`}
    >
      <div className="flex items-start gap-3">
        {/* Radio circle */}
        <span
          className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors
            ${selected ? "border-signal-gold bg-signal-gold" : "border-border bg-clear-ballot"}`}
          aria-hidden="true"
        >
          {selected && (
            <span className="w-2 h-2 rounded-full bg-clear-ballot" />
          )}
        </span>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {/* Label */}
          <span className="text-body font-medium text-ballot-ink">
            {label}
          </span>

          {/* Description */}
          {description && (
            <p className="text-secondary text-quiet-ink mt-1">{description}</p>
          )}

          {/* Results */}
          {showResults && (walletCount !== undefined || nimAmount !== undefined || percentage !== undefined) && (
            <div className="mt-3 space-y-2">
              {/* Stats row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {walletCount !== undefined && (
                    <span className="text-proof text-nim-blue">
                      {walletCount.toLocaleString()} wallet
                      {walletCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {nimAmount !== undefined && (
                    <span className="text-proof text-nim-blue">
                      {nimAmount.toLocaleString()} NIM
                    </span>
                  )}
                </div>
                {percentage !== undefined && (
                  <span className="text-micro text-quiet-ink">
                    {percentage}%
                  </span>
                )}
              </div>

              {/* Percentage bar */}
              {percentage !== undefined && (
                <div className="w-full h-1.5 rounded-full bg-soft-fog overflow-hidden">
                  <div
                    className="h-full rounded-full bg-nim-blue transition-all"
                    style={{ width: `${Math.min(percentage, 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right-aligned results when no description/bar shown */}
        {showResults && !description && (walletCount !== undefined || nimAmount !== undefined) && (
          <div className="flex-shrink-0 text-right">
            {walletCount !== undefined && (
              <span className="block text-proof text-nim-blue">
                {walletCount.toLocaleString()} wallet
                {walletCount !== 1 ? "s" : ""}
              </span>
            )}
            {nimAmount !== undefined && (
              <span className="block text-proof text-nim-blue">
                {nimAmount.toLocaleString()} NIM
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
