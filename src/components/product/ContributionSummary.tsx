import { Card } from "@/components/ui/Card";

interface ContributionSummaryProps {
  totalWallets: number;
  totalNim: number;
  optionCount: number;
  className?: string;
}

export function ContributionSummary({
  totalWallets,
  totalNim,
  optionCount,
  className = "",
}: ContributionSummaryProps) {
  return (
    <Card className={`p-6 ${className}`}>
      <div className="flex flex-wrap items-center gap-6">
        {/* Wallet count */}
        <div className="flex items-center gap-2">
          {/* Wallet icon */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M15 4.5H3C2.17157 4.5 1.5 5.17157 1.5 6V13.5C1.5 14.3284 2.17157 15 3 15H15C15.8284 15 16.5 14.3284 16.5 13.5V6C16.5 5.17157 15.8284 4.5 15 4.5Z"
              stroke="#68716B"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 10.5C12 11.3284 12.6716 12 13.5 12H16.5V9H13.5C12.6716 9 12 9.67157 12 10.5Z"
              stroke="#68716B"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <span className="block text-body text-ballot-ink">
              {totalWallets.toLocaleString()}
            </span>
            <span className="block text-micro text-quiet-ink">wallets</span>
          </div>
        </div>

        {/* NIM total */}
        <div className="flex items-center gap-2">
          {/* NIM icon (simple diamond/hex shape) */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M9 1.5L16.5 5.25V12.75L9 16.5L1.5 12.75V5.25L9 1.5Z"
              stroke="#4F73A8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 9L16.5 5.25"
              stroke="#4F73A8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 9V16.5"
              stroke="#4F73A8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 9L1.5 5.25"
              stroke="#4F73A8"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <span className="block text-body text-nim-blue">
              {totalNim.toLocaleString()}
            </span>
            <span className="block text-micro text-quiet-ink">NIM</span>
          </div>
        </div>

        {/* Option count */}
        <div>
          <span className="block text-body text-ballot-ink">
            {optionCount.toLocaleString()}
          </span>
          <span className="block text-micro text-quiet-ink">
            option{optionCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </Card>
  );
}
