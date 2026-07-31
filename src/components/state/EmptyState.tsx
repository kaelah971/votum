import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-[24px] border border-white/75 bg-clear-ballot/64 px-5 py-16 text-center shadow-card backdrop-blur ${className}`}
    >
      {icon ? (
        <div className="mb-6 text-quiet-ink">{icon}</div>
      ) : (
        <div className="mb-6 w-16 h-16 rounded-full bg-soft-fog" />
      )}
      <h2 className="text-section-heading font-display text-ballot-ink">
        {title}
      </h2>
      <p className="mt-3 max-w-sm text-body text-quiet-ink">
        {description}
      </p>
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}
