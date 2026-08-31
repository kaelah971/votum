import { Card } from "@/components/ui/Card";
import { truncateTxHash } from "@/lib/format";
import type { PollView } from "@/types/poll";

interface VotumReceiptProps {
  economicModel: PollView["economicModel"];
  amount?: number;
  option: string;
  timestamp: string;
  txHash?: string;
  pollQuestion: string;
  className?: string;
}

export function VotumReceipt({
  economicModel,
  amount,
  option,
  timestamp,
  txHash,
  pollQuestion,
  className = "",
}: VotumReceiptProps) {
  const isLegacySupport = economicModel === "legacy_support";

  return (
    <Card className={`p-6 ${className}`}>
      <div className="space-y-4">
        {/* Receipt heading */}
        <h3 className="text-card-heading font-display text-ballot-ink">
          {isLegacySupport
            ? "Your legacy support signal is recorded"
            : "Your verified vote is recorded"}
        </h3>

        {/* Proof data section */}
        <div className="space-y-2">
          {/* NIM amount */}
          {amount !== undefined && (
            <p className="text-proof text-nim-blue">
              {amount.toLocaleString()} NIM support
            </p>
          )}

          {/* Chosen option */}
          <p className="text-body text-ballot-ink">{option}</p>

          {/* Timestamp */}
          <p className="text-micro text-quiet-ink">{timestamp}</p>

          {/* TX hash */}
          {txHash && (
            <p className="text-proof text-nim-blue">
              tx: {truncateTxHash(txHash)}
            </p>
          )}
        </div>

        {/* Divider */}
        <hr className="border-divider" />

        {/* Poll question — secondary context, never reveals full wallet data */}
        <p className="text-secondary text-quiet-ink">{pollQuestion}</p>
      </div>
    </Card>
  );
}
