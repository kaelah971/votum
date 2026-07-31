import type { ReactNode } from "react";

interface FrameStatPillProps {
  label: string;
  value: string;
  icon?: ReactNode;
  className?: string;
}

export function FrameStatPill({
  label,
  value,
  icon,
  className = "",
}: FrameStatPillProps) {
  return (
    <span
      className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-ballot-ink/18 bg-clear-ballot/45 px-4 text-xs font-medium text-ballot-ink backdrop-blur ${className}`}
    >
      {icon && <span className="text-quiet-ink">{icon}</span>}
      <span>{value}</span>
      <span className="hidden text-quiet-ink sm:inline">{label}</span>
    </span>
  );
}

