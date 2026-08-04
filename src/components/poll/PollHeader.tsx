import type { PollStatus } from "@/types/poll";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { Badge } from "@/components/ui/Badge";
import { PollTaxonomyBadges } from "@/components/product/PollTaxonomyBadges";
import { formatClosingTime } from "@/lib/format";

// ---------------------------------------------------------------------------
// Map the domain PollStatus to Badge variant and display label
// ---------------------------------------------------------------------------

const statusBadgeVariant: Record<PollStatus, "signal" | "default" | "reject"> = {
  live: "signal",
  closed: "default",
  draft: "default",
  cancelled: "reject",
};

const statusLabel: Record<PollStatus, string> = {
  live: "Live",
  closed: "Closed",
  draft: "Draft",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollHeaderProps {
  question: string;
  context?: string;
  status: PollStatus;
  closingAt?: string;
  category?: PollCategory;
  format?: PollFormat;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollHeader({
  question,
  context,
  status,
  closingAt,
  category,
  format,
  className = "",
}: PollHeaderProps) {
  return (
    <header className={`space-y-3 ${className}`}>
      {/* Status badge + time remaining */}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={statusBadgeVariant[status]}>
          {statusLabel[status]}
        </Badge>

        {/* Show closing deadline only for live polls */}
        {status === "live" && closingAt && (
          <span className="text-micro text-fairness-amber">
            Closes {formatClosingTime(new Date(closingAt))}
          </span>
        )}
      </div>

      {/* Taxonomy badges */}
      {category && format && (
        <PollTaxonomyBadges category={category} format={format} size="sm" />
      )}

      {/* Poll question */}
      <h1 className="text-section-heading font-display text-ballot-ink">
        {question}
      </h1>

      {/* Optional context / explanation */}
      {context && (
        <p className="text-body text-quiet-ink">{context}</p>
      )}

      {/* Share placeholder — non-functional, communicates intent */}
      <div className="pt-1">
        <span className="text-micro text-micro-grey select-none">
          Share
        </span>
      </div>
    </header>
  );
}
