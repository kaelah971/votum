import Link from "next/link";
import { MarketingShell } from "@/components/layout/MarketingShell";

/**
 * 404 Not Found page — server component.
 *
 * Wraps content inside MarketingShell so the marketing nav and footer
 * remain visible even when the user lands on a missing route.
 */
export default function NotFound() {
  return (
    <MarketingShell>
      <div className="flex flex-col items-center justify-center py-16 text-center">
        {/* Eyebrow */}
        <p className="text-micro text-quiet-ink tracking-wider mb-2">
          PAGE NOT FOUND
        </p>

        {/* Headline */}
        <h1 className="text-section-heading font-display text-ballot-ink">
          This decision is not here.
        </h1>

        {/* Supporting copy */}
        <p className="text-body text-quiet-ink mt-2 max-w-md">
          The page may have moved, or the link may no longer be available.
        </p>

        {/* CTAs — gold pill primary + secondary text link */}
        <div className="flex gap-3 mt-6">
          <Link
            href="/explore"
            className="inline-flex rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium px-6 py-3 text-sm transition-colors"
          >
            Explore public polls
          </Link>
          <Link
            href="/"
            className="text-body text-quiet-ink hover:text-ballot-ink transition-colors"
          >
            Return home
          </Link>
        </div>
      </div>
    </MarketingShell>
  );
}
