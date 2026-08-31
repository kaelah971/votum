import Link from "next/link";
import type { ReceiptView } from "@/types/poll";
import { VotumReceipt } from "@/components/product/VotumReceipt";
import { ProofPath } from "@/components/ui/ProofPath";
import { Button } from "@/components/ui/Button";

interface VotumReceiptViewProps {
  receipt: ReceiptView;
  className?: string;
}

/**
 * Enhanced receipt display that wraps the existing VotumReceipt component
 * with a proof path, contextual controls, and a privacy note.
 *
 * The wallet address MUST NOT be shown in the receipt.
 */
export function VotumReceiptView({
  receipt,
  className = "",
}: VotumReceiptViewProps) {
  const hasControls = Boolean(receipt.explorerUrl) || Boolean(receipt.pollUrl);
  const isLegacySupport = receipt.economicModel === "legacy_support";

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Proof path breadcrumb */}
      <ProofPath
        steps={
          isLegacySupport
            ? ["question", "choice", "verified NIM", "result"]
            : ["question", "choice", "verified vote", "result"]
        }
        className="mb-4"
      />

      {/* Heading */}
      <h2 className="text-section-heading font-display text-ballot-ink">
        {isLegacySupport
          ? "Your legacy support signal is recorded"
          : "Your verified vote is recorded"}
      </h2>

      {/* Core receipt display */}
      <VotumReceipt
        economicModel={receipt.economicModel}
        amount={isLegacySupport ? receipt.nimContribution : undefined}
        option={receipt.chosenOption}
        timestamp={receipt.recordedAt}
        txHash={isLegacySupport ? receipt.transactionRef : undefined}
        pollQuestion={receipt.pollQuestion}
      />

      {/* Controls area — only shown when real URLs exist */}
      {hasControls && (
        <div className="flex flex-wrap items-center gap-3">
          {receipt.explorerUrl && (
            <Link
              href={receipt.explorerUrl}
              className="inline-flex items-center justify-center rounded-full bg-soft-fog text-ballot-ink border border-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold"
            >
              View transaction
            </Link>
          )}

          {receipt.pollUrl && (
            <Link
              href={receipt.pollUrl}
              className="inline-flex items-center justify-center rounded-full bg-soft-fog text-ballot-ink border border-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold"
            >
              Return to poll
            </Link>
          )}

          {/* Share receipt — placeholder, no real sharing wired */}
          <Button variant="ghost" size="sm" disabled>
            Share receipt
          </Button>
        </div>
      )}

      {/* Privacy note */}
      <p className="text-micro text-quiet-ink">
        This receipt does not expose full wallet data.
      </p>
    </div>
  );
}
