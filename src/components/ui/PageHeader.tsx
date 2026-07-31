import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <header className="mb-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-page-title font-display text-ballot-ink">
            {title}
          </h1>
          {description && (
            <p className="text-body-lg text-quiet-ink mt-2 max-w-prose">
              {description}
            </p>
          )}
        </div>
        {children && (
          <div className="flex-shrink-0 flex items-center gap-3">
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
