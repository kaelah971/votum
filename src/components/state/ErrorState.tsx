import { Button } from "@/components/ui/Button";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

const ErrorIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M24 16v10"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="24" cy="33" r="1.5" fill="currentColor" />
  </svg>
);

export function ErrorState({
  title = "Something went wrong",
  description = "We couldn't load this right now. Please try again.",
  onRetry,
  className = "",
}: ErrorStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-16 px-5 w-full max-w-md mx-auto ${className}`}
    >
      <div className="mb-6 text-reject-red opacity-80">
        <ErrorIcon />
      </div>
      <h2 className="text-section-heading font-display text-ballot-ink text-center">
        {title}
      </h2>
      <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
        {description}
      </p>
      {onRetry && (
        <div className="mt-8">
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
