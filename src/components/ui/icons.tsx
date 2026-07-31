// ---------------------------------------------------------------------------
// Shared SVG icon components.
//
// Each icon accepts an optional `className` for Tailwind styling and uses
// `currentColor` so colour is inherited from the parent element.
// No "use client" directive needed — these are pure SVG renders.
// ---------------------------------------------------------------------------

/** Simple wallet icon (16×16). Used in WalletButton. */
export function WalletIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="1.5"
        y="3.5"
        width="13"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M11 7.5H11.007"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Large wallet icon with circle-plus overlay (48×48). Used in wallet-required states. */
export function WalletIconLarge({ className = "" }: { className?: string }) {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="7"
        y="12"
        width="34"
        height="24"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M30 23h.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="28" cy="24" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M24 20v8M20 24h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Clipboard copy icon (14×14). Used in ProofReference and DestinationWallet. */
export function CopyIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="4"
        y="4"
        width="9"
        height="9"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M2 10V2.5C2 2.22386 2.22386 2 2.5 2H10"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Checkmark icon (16×16). Used in Button verified variant. */
export function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M13.5 4.5L6 12L2.5 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Verified checkmark icon (14×14). Used in ProofReference for the verified state label. */
export function VerifiedCheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M11.5 3.5L5.5 9.5L2.5 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Close / X icon (16×16). Used in PollOptionsEditor for removing an option. */
export function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M4 4L12 12M12 4L4 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Magnifying glass search icon (16×16). Used in ExploreToolbar. */
export function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle
        cx="6.5"
        cy="6.5"
        r="4.75"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Arrow-up-right icon (12×12). Used across multiple pages as an eyebrow element. */
export function ArrowUpRightIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
