interface UnavailableStateProps {
  title?: string;
  description?: string;
  className?: string;
}

const NotFoundIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M16 16l16 16M16 32l16-16"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export function UnavailableState({
  title = "Not found",
  description = "This poll or receipt could not be found. It may have been removed or the link may be incorrect.",
  className = "",
}: UnavailableStateProps) {
  return (
    <div
      className={`mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-[24px] border border-white/75 bg-clear-ballot/64 px-5 py-16 text-center shadow-card backdrop-blur ${className}`}
    >
      <div className="mb-6 text-quiet-ink">
        <NotFoundIcon />
      </div>
      <h2 className="text-section-heading font-display text-ballot-ink">
        {title}
      </h2>
      <p className="mt-3 max-w-sm text-body text-quiet-ink">
        {description}
      </p>
    </div>
  );
}
