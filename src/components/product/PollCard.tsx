import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { PollStatus } from "@/types/poll";

interface PollCardProps {
  question: string;
  creatorName?: string;
  totalWallets?: number;
  totalNim?: number;
  optionCount?: number;
  status: PollStatus;
  href: string;
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
  className = "",
}: PollCardProps) {
  return (
    <Link href={href} className={`block ${className}`}>
      <Card className="p-6 space-y-4 hover:shadow-card transition-shadow">
        {/* Question */}
        <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
          {question}
        </h3>

        {/* Creator */}
        {creatorName && (
          <p className="text-secondary text-quiet-ink">{creatorName}</p>
        )}

        {/* Stats row: wallets + NIM */}
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
                {totalNim.toLocaleString()} NIM
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
          <Badge variant={statusBadgeVariant[status]}>
            {statusLabel[status]}
          </Badge>
        </div>
      </Card>
    </Link>
  );
}
