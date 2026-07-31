import { Card } from "@/components/ui/Card";
import { truncateTxHash } from "@/lib/format";

interface VotumReceiptProps {
  amount: number;
  option: string;
  timestamp: string;
  txHash: string;
  pollQuestion: string;
  className?: string;
}

export function VotumReceipt({
  amount,
  option,
  timestamp,
  txHash,
  pollQuestion,
  className = "",
}: VotumReceiptProps) {
  return (
    <Card className={`p-6 ${className}`}>
      <div className="space-y-4">
        {/* Receipt heading */}
        <h3 className="text-card-heading font-display text-ballot-ink">
          Your NIM-backed signal is recorded
        </h3>

        {/* Proof data section */}
        <div className="space-y-2">
          {/* NIM amount */}
          <p className="text-proof text-nim-blue">
            {amount.toLocaleString()} NIM
          </p>

          {/* Chosen option */}
          <p className="text-body text-ballot-ink">{option}</p>

          {/* Timestamp */}
          <p className="text-micro text-quiet-ink">{timestamp}</p>

          {/* TX hash */}
          <p className="text-proof text-nim-blue">
            tx: {truncateTxHash(txHash)}
          </p>
        </div>

        {/* Divider */}
        <hr className="border-divider" />

        {/* Poll question — secondary context, never reveals full wallet data */}
        <p className="text-secondary text-quiet-ink">{pollQuestion}</p>
      </div>
    </Card>
  );
}
