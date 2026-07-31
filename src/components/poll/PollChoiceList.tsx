import type { PollOptionView } from "@/types/poll";
import { PollOption } from "@/components/product/PollOption";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollChoiceListProps {
  options: PollOptionView[];
  selectedOptionId?: string;
  onSelect?: (optionId: string) => void;
  showResults?: boolean;
  disabled?: boolean;
  leadingOptionId?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollChoiceList({
  options,
  selectedOptionId,
  onSelect,
  showResults = false,
  disabled = false,
  leadingOptionId,
  className = "",
}: PollChoiceListProps) {
  if (options.length === 0) {
    return (
      <div className={`text-center py-8 text-body text-quiet-ink ${className}`}>
        No options are available for this poll.
      </div>
    );
  }

  return (
    <fieldset className={`space-y-3 ${className}`}>
      <legend className="sr-only">Poll options</legend>

      {options.map((option) => {
        const isSelected = option.id === selectedOptionId;
        const isLeading = option.id === leadingOptionId;

        return (
          <div key={option.id} className="relative">
            {/* Subtle visual treatment for the leading option */}
            {isLeading && (
              <span
                className="absolute -left-1 top-1 bottom-1 w-1 rounded-l-full bg-signal-gold"
                aria-hidden="true"
              />
            )}

            <PollOption
              label={option.label}
              selected={isSelected}
              walletCount={option.walletCount}
              nimAmount={option.nimSignalled}
              percentage={option.percentage}
              showResults={showResults}
              disabled={disabled}
              onClick={onSelect ? () => onSelect(option.id) : undefined}
            />
          </div>
        );
      })}
    </fieldset>
  );
}
