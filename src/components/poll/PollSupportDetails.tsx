import type { ContributionMode } from "@/types/poll";
import { Card } from "@/components/ui/Card";
import { truncateAddress } from "@/lib/format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PollSupportDetailsProps {
  destinationPurpose: string;
  destinationWallet: string;
  contributionMode: ContributionMode;
  minimumNim: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PollSupportDetails({
  destinationPurpose,
  destinationWallet,
  contributionMode,
  minimumNim,
  className = "",
}: PollSupportDetailsProps) {
  return (
    <Card className={`p-6 space-y-4 ${className}`}>
      {/* Heading */}
      <h3 className="text-card-heading font-display text-ballot-ink">
        What the NIM supports
      </h3>

      {/* Destination purpose */}
      <p className="text-body text-ballot-ink">{destinationPurpose}</p>

      {/* Destination wallet (truncated, proof font, nim-blue) */}
      <p className="text-proof text-nim-blue break-all">
        {truncateAddress(destinationWallet)}
      </p>

      {/* Minimum NIM contribution */}
      <p className="text-body text-quiet-ink">
        Minimum contribution:{" "}
        <span className="text-proof text-nim-blue">
          {minimumNim.toLocaleString()} NIM
        </span>
      </p>

      {/* Contribution mode context — subtle, not the primary message */}
      <p className="text-micro text-micro-grey">
        {contributionMode === "creator"
          ? "NIM goes to the poll creator."
          : "NIM goes to the community treasury."}
      </p>
    </Card>
  );
}
