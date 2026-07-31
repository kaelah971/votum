import type { ReactNode } from "react";

interface ReferenceCapsuleItem {
  title: string;
  meta: string;
  action?: ReactNode;
  visual?: ReactNode;
}

interface ReferenceCapsuleStripProps {
  items: ReferenceCapsuleItem[];
  className?: string;
}

export function ReferenceCapsuleStrip({
  items,
  className = "",
}: ReferenceCapsuleStripProps) {
  return (
    <div
      className={`grid grid-cols-1 gap-4 md:grid-cols-3 ${className}`}
      aria-label="Votum quick actions"
    >
      {items.map((item) => (
        <div
          key={item.title}
          className="flex min-h-[76px] items-center gap-4 rounded-full border border-white/80 bg-clear-ballot/72 px-4 py-3 shadow-card backdrop-blur"
        >
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-ballot-ink text-clear-ballot">
            {item.visual}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ballot-ink">
              {item.title}
            </p>
            <p className="truncate text-micro text-quiet-ink">{item.meta}</p>
          </div>
          {item.action}
        </div>
      ))}
    </div>
  );
}

