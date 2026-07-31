interface LoadingStateProps {
  variant?: "card" | "list" | "page";
  count?: number;
  className?: string;
}

function SkeletonCard() {
  return <div className="animate-pulse bg-soft-fog rounded-card h-48 w-full" />;
}

function SkeletonRow() {
  return <div className="animate-pulse bg-soft-fog rounded-overlay h-16 w-full" />;
}

function SkeletonList({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

function SkeletonPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header area */}
      <div className="flex flex-col gap-3">
        <div className="animate-pulse bg-soft-fog rounded-overlay h-9 w-1/3" />
        <div className="animate-pulse bg-soft-fog rounded-overlay h-5 w-2/3" />
      </div>
      {/* Content rows */}
      <SkeletonList count={4} />
    </div>
  );
}

export function LoadingState({
  variant = "card",
  count = 3,
  className = "",
}: LoadingStateProps) {
  const content = (() => {
    switch (variant) {
      case "card":
        return <SkeletonCard />;
      case "list":
        return <SkeletonList count={count} />;
      case "page":
        return <SkeletonPage />;
    }
  })();

  return <div className={className}>{content}</div>;
}
