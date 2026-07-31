"use client";

import { IconButton } from "./IconButton";
import { CopyIcon } from "@/components/ui/icons";
import { truncateAddress } from "@/lib/format";

interface DestinationWalletProps {
  label?: string;
  address?: string;
  purpose?: string;
}

export function DestinationWallet({
  label = "Destination",
  address,
  purpose,
}: DestinationWalletProps) {
  if (!address) {
    return (
      <div className="rounded-card border border-dashed border-divider p-4">
        <p className="text-micro text-micro-grey">No destination set</p>
      </div>
    );
  }

  const truncated = truncateAddress(address);

  return (
    <div className="rounded-card border border-divider bg-clear-ballot p-4">
      <p className="text-micro text-quiet-ink mb-1">{label}</p>
      {purpose && <p className="text-body text-ballot-ink mb-2">{purpose}</p>}
      <div className="flex items-center gap-2">
        <code className="text-proof text-ballot-ink">{truncated}</code>
        <IconButton
          label="Copy address"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(address).catch(() => {
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
