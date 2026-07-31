interface ProofPathProps {
  steps?: string[];
  activeStep?: number;
  className?: string;
}

export function ProofPath({
  steps = ["question", "choice", "verified NIM", "result"],
  activeStep,
  className = "",
}: ProofPathProps) {
  return (
    <nav
      aria-label="Proof path"
      className={`flex flex-wrap items-center gap-y-2 ${className}`}
    >
      {steps.map((step, index) => {
        const isActive = activeStep === index;
        return (
          <span key={step} className="flex items-center">
            <span
              className={`text-micro ${
                isActive
                  ? "font-medium text-ballot-ink"
                  : "text-quiet-ink"
              }`}
            >
              {step}
            </span>
            {index < steps.length - 1 && (
              <span
                className="mx-1.5 select-none text-micro-grey"
                aria-hidden="true"
              >
                /\
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

