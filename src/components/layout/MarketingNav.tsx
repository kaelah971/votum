import Link from "next/link";
import { FrameStatPill } from "@/components/layout/FrameStatPill";
import { WalletButton } from "@/components/ui/WalletButton";

const VotumMark = () => (
  <>
    <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-signal-gold text-ballot-ink shadow-[inset_0_-10px_18px_rgba(24,32,29,0.08)]">
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12.5 5.75L8 12.25L5.5 9.25"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.6 10.2C13.1 12.1 11.3 13.5 9.2 13.5C6.7 13.5 4.7 11.5 4.7 9C4.7 6.5 6.7 4.5 9.2 4.5C10.2 4.5 11.1 4.8 11.8 5.4"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    </span>
    <span className="hidden font-display text-body-lg font-medium text-ballot-ink sm:inline">
      Votum
    </span>
  </>
);

export function MarketingNav() {
  return (
    <nav
      className="px-4 pt-4 sm:px-6 md:px-8"
      role="navigation"
      aria-label="Marketing navigation"
    >
      <div className="mx-auto grid min-h-16 max-w-[1180px] grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 justify-self-start"
          aria-label="Votum home"
        >
          <VotumMark />
        </Link>

        <div className="hidden items-center rounded-full border border-ballot-ink/10 bg-clear-ballot/40 px-2 py-1 text-xs font-medium text-quiet-ink backdrop-blur md:flex">
          <Link
            href="/explore"
            className="rounded-full px-4 py-2 transition-colors hover:text-ballot-ink"
          >
            Explore
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href="/how-it-works"
            className="rounded-full px-4 py-2 text-ballot-ink transition-colors hover:bg-clear-ballot/70"
          >
            How it works
          </Link>
        </div>

        <div className="flex items-center gap-2 justify-self-end">
          <FrameStatPill
            value="+127"
            label="NIM signalled"
            className="hidden lg:inline-flex"
          />
          <Link
            href="/create"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-ballot-ink/18 bg-clear-ballot/45 px-4 text-xs font-medium text-ballot-ink backdrop-blur transition-colors hover:bg-clear-ballot/80"
          >
            Create
          </Link>
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}

