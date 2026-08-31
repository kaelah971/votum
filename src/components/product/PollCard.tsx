import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PollTaxonomyBadges } from "@/components/product/PollTaxonomyBadges";
import type { PollStatus } from "@/types/poll";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { parseTimestamp } from "@/lib/explore/filters";

interface PollCardProps {
  question: string;
  creatorName?: string;
  totalWallets?: number;
  totalNim?: number;
  optionCount?: number;
  status: PollStatus;
  href: string;
  category?: PollCategory;
  format?: PollFormat;
  closingAt?: string;
  rewarded?: boolean;
  rewardPerParticipantNim?: string;
  className?: string;
}

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

export function PollCard({
  question,
  creatorName,
  totalWallets,
  totalNim,
  optionCount,
  status,
  href,
  category,
  format,
  closingAt,
  rewarded = false,
  rewardPerParticipantNim,
  className = "",
}: PollCardProps) {
  return (
    <Link href={href} className={`block ${className}`}>
      <Card className="p-6 space-y-3 hover:shadow-card transition-shadow">
        {/* Question */}
        <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
          {question}
        </h3>

        {/* Taxonomy */}
        {category && format && (
          <PollTaxonomyBadges category={category} format={format} size="sm" />
        )}

        {/* Creator */}
        {creatorName && (
          <p className="text-secondary text-quiet-ink">{creatorName}</p>
        )}

        {/* Closing info */}
        {(() => {
          const endsAt = parseTimestamp(closingAt);
          if (endsAt === null) return null;
          if (status !== "live") return null;
          return (
            <p className="text-micro text-fairness-amber">
              Closes {new Date(endsAt).toLocaleDateString("en-US", {
                month: "short", day: "numeric",
              })}
            </p>
          );
        })()}

        {/* Stats row: wallets + any legacy support total */}
        {(totalWallets !== undefined || totalNim !== undefined) && (
          <div className="flex items-center gap-4">
            {totalWallets !== undefined && (
              <span className="text-proof text-nim-blue">
                {totalWallets.toLocaleString()} wallet
                {totalWallets !== 1 ? "s" : ""}
              </span>
            )}
            {totalNim !== undefined && (
              <span className="text-proof text-nim-blue">
                 {totalNim.toLocaleString()} legacy NIM support
              </span>
            )}
          </div>
        )}

        {/* Footer: option count + status badge */}
        <div className="flex items-center justify-between">
          {optionCount !== undefined && (
            <span className="text-micro text-quiet-ink">
              {optionCount} option{optionCount !== 1 ? "s" : ""}
            </span>
          )}
          <div className="flex items-center gap-2">
            {rewarded && (
              <Badge variant="signal">
                {rewardPerParticipantNim
                  ? `Earn ${rewardPerParticipantNim}`
                  : "Rewarded"}
              </Badge>
            )}
            <Badge variant={statusBadgeVariant[status]}>
              {statusLabel[status]}
            </Badge>
          </div>
        </div>
      </Card>
    </Link>
  );
}
