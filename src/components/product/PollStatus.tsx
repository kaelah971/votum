import { Badge } from "@/components/ui/Badge";
import type { PollStatus as PollStatusType } from "@/types/poll";

interface PollStatusProps {
  status: PollStatusType;
  deadline?: string;
  className?: string;
}

const statusBadgeVariant: Record<PollStatusType, "signal" | "default" | "verified" | "reject"> = {
  live: "signal",
  closed: "default",
  draft: "default",
  cancelled: "reject",
};

const statusLabel: Record<PollStatusType, string> = {
  live: "Live",
  closed: "Closed",
  draft: "Draft",
  cancelled: "Cancelled",
};

export function PollStatus({
  status,
  deadline,
  className = "",
}: PollStatusProps) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <Badge variant={statusBadgeVariant[status]}>
        {statusLabel[status]}
      </Badge>

      {/* Countdown for active polls with a deadline */}
      {status === "live" && deadline && (
        <span className="text-micro text-fairness-amber">
          Closes {deadline}
        </span>
      )}
    </div>
  );
}
