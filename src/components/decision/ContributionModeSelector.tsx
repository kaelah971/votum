"use client";

import type { ContributionMode } from "@/types/poll";
import { Radio } from "@/components/ui/Radio";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ContributionModeSelectorProps {
  value: ContributionMode | null;
  onChange: (mode: ContributionMode) => void;
  error?: string;
}

export function ContributionModeSelector({
  value,
  onChange,
  error,
}: ContributionModeSelectorProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ballot-ink">
        Contribution mode
      </span>
      {error && (
        <p className="text-micro text-reject-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        <Radio
          name="contributionMode"
          value="creator"
          label="Creator Support"
          description="NIM goes directly to the creator or project wallet and supports their work."
          checked={value === "creator"}
          onChange={(v) => onChange(v as ContributionMode)}
        />
        <Radio
          name="contributionMode"
          value="community"
          label="Community Support"
          description="NIM goes directly to a disclosed community or project wallet."
          checked={value === "community"}
          onChange={(v) => onChange(v as ContributionMode)}
        />
      </div>
    </div>
  );
}
