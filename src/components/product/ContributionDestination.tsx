"use client";

import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { useCallback, useState } from "react";
import { truncateAddress } from "@/lib/format";

type DestinationType = "creator" | "community" | "project";

interface ContributionDestinationProps {
  walletAddress: string;
  destinationType: DestinationType;
  purpose: string;
  className?: string;
}

const destinationBadgeVariant: Record<DestinationType, "signal" | "nim" | "default"> = {
  creator: "signal",
  community: "nim",
  project: "default",
};

const destinationLabel: Record<DestinationType, string> = {
  creator: "Creator",
  community: "Community",
  project: "Project",
};

export function ContributionDestination({
  walletAddress,
  destinationType,
  purpose,
  className = "",
}: ContributionDestinationProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available — silently ignore
    }
  }, [walletAddress]);

  return (
    <Card className={`p-6 ${className}`}>
      <div className="space-y-4">
        {/* Heading */}
        <h3 className="text-card-heading font-display text-ballot-ink">
          Your NIM supports...
        </h3>

        {/* Destination type badge */}
        <Badge variant={destinationBadgeVariant[destinationType]}>
          {destinationLabel[destinationType]}
        </Badge>

        {/* Purpose */}
        <p className="text-body text-ballot-ink">{purpose}</p>

        {/* Wallet address with copy */}
        <div className="flex items-center gap-2">
          <span className="text-proof text-nim-blue">
            {truncateAddress(walletAddress)}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex-shrink-0 p-1 rounded-full bg-soft-fog hover:bg-divider transition-colors"
            aria-label={copied ? "Copied" : "Copy wallet address"}
          >
            {copied ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M11.5 3.5L5.5 9.5L2.5 6.5"
                  stroke="#3D7659"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
              >
                <rect
                  x="4"
                  y="4"
                  width="8"
                  height="8"
                  rx="1.5"
                  stroke="#68716B"
                  strokeWidth="1.25"
                />
                <path
                  d="M2 10V2.5C2 2.22386 2.22386 2 2.5 2H10"
                  stroke="#68716B"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </Card>
  );
}
