import type { ReactNode } from "react";

interface SectionHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

export function SectionHeader({
  title,
  description,
  children,
}: SectionHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-section-heading font-display text-ballot-ink">
            {title}
          </h2>
          {description && (
            <p className="text-body text-quiet-ink mt-1">{description}</p>
          )}
        </div>
        {children && (
          <div className="flex-shrink-0 flex items-center gap-3">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
