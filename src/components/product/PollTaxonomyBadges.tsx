import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { CATEGORY_LABELS, FORMAT_LABELS } from "@/lib/polls/taxonomy";

interface PollTaxonomyBadgesProps {
  category: PollCategory;
  format: PollFormat;
  size?: "sm" | "md";
  className?: string;
}

export function PollTaxonomyBadges({
  category,
  format,
  size = "md",
  className = "",
}: PollTaxonomyBadgesProps) {
  const textSize = size === "sm" ? "text-[11px]" : "text-xs";
  const spacing = size === "sm" ? "gap-0.5" : "gap-1";

  return (
    <div
      className={`inline-flex flex-wrap items-center ${spacing} ${className}`}
      aria-label={`Category: ${CATEGORY_LABELS[category]}, Format: ${FORMAT_LABELS[format]}`}
    >
      <span
        className={`inline-block rounded-full border border-border bg-soft-fog px-2 py-0.5 ${textSize} font-medium text-quiet-ink`}
      >
        {CATEGORY_LABELS[category]}
      </span>
      <span
        className={`inline-block rounded-full border border-border bg-soft-fog px-2 py-0.5 ${textSize} font-medium text-quiet-ink`}
      >
        {FORMAT_LABELS[format]}
      </span>
    </div>
  );
}
