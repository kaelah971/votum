import type { ReactNode } from "react";

interface SurfaceProps {
  children: ReactNode;
  className?: string;
}

export function Surface({ children, className = "" }: SurfaceProps) {
  return (
    <div
      className={`rounded-card bg-clear-ballot border border-divider ${className}`}
    >
      {children}
    </div>
  );
}
