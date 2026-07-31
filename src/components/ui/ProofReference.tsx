"use client";

import { IconButton } from "./IconButton";
import { CopyIcon, VerifiedCheckIcon } from "@/components/ui/icons";
import { truncateTxHash } from "@/lib/format";

interface ProofReferenceProps {
  txHash?: string;
  timestamp?: string;
}

export function ProofReference({ txHash, timestamp }: ProofReferenceProps) {
  if (!txHash) return null;

  const truncated = truncateTxHash(txHash);

  return (
    <div className="rounded-card border border-divider bg-clear-ballot p-4">
      <div className="flex items-center mb-2">
        <VerifiedCheckIcon className="text-nim-blue mr-1.5 flex-shrink-0" />
        <span className="text-sm font-medium text-nim-blue">
          Verified transaction
        </span>
      </div>
      {timestamp && (
        <p className="text-micro text-quiet-ink mb-1.5">{timestamp}</p>
      )}
      <div className="flex items-center gap-2">
        <code className="text-proof text-ballot-ink">{truncated}</code>
        <IconButton
          label="Copy transaction hash"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(txHash).catch(() => {
              // Clipboard API may fail in insecure contexts; silently ignore
            });
          }}
        >
          <CopyIcon />
        </IconButton>
      </div>
    </div>
  );
}
