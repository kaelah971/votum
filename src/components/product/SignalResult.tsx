import { Card } from "@/components/ui/Card";

interface SignalResultProps {
  leadingOption: string;
  walletCount: number;
  nimSignalled: number;
  percentageOfVoters?: number;
  totalWallets?: number;
  totalNim?: number;
  className?: string;
}

export function SignalResult({
  leadingOption,
  walletCount,
  nimSignalled,
  percentageOfVoters,
  totalWallets,
  totalNim,
  className = "",
}: SignalResultProps) {
  return (
    <Card className={`p-6 ${className}`}>
      <div className="space-y-4">
        {/* Leading option name */}
        <h3 className="text-card-heading font-display text-ballot-ink">
          {leadingOption}
        </h3>

        {/* Legacy support and wallet measures stay visibly separate. */}
        <div className="flex flex-wrap gap-6">
          <div>
            <span className="block text-body text-ballot-ink">
              {walletCount.toLocaleString()} wallet
              {walletCount !== 1 ? "s" : ""} chose this
            </span>
          </div>
          <div>
            <span className="block text-proof text-nim-blue">
              {nimSignalled.toLocaleString()} legacy NIM support
            </span>
          </div>
        </div>

        {/* Percentage */}
        {percentageOfVoters !== undefined && (
          <p className="text-micro text-quiet-ink">
            {percentageOfVoters}% of voters chose this option
          </p>
        )}

        {/* "of X total" context */}
        {(totalWallets !== undefined || totalNim !== undefined) && (
          <p className="text-micro text-quiet-ink">
            of{" "}
            {totalWallets !== undefined && (
              <span>
                {totalWallets.toLocaleString()} total wallet
                {totalWallets !== 1 ? "s" : ""}
              </span>
            )}
            {totalWallets !== undefined && totalNim !== undefined && " · "}
            {totalNim !== undefined && (
              <span>{totalNim.toLocaleString()} total legacy NIM support</span>
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
