"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

/**
 * Votum-wide React error boundary (client component).
 *
 * Catches rendering errors anywhere in the tree. Does NOT rely on
 * MarketingShell or ProductShell because the error may have occurred
 * in any layout context. Renders a minimal centered view with no
 * sensitive information exposed.
 *
 * @remarks Never renders `error.message` or stack traces to users.
 */
interface ErrorPageProps {
  error: Error;
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  // Log the error for debugging in development environments only.
  // The error detail is never surfaced in the rendered UI.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      console.error("Votum error boundary caught:", error);
    }
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-soft-fog">
      <div className="flex flex-col items-center text-center px-5 max-w-md">
        {/* Eyebrow */}
        <p className="text-micro text-quiet-ink tracking-wider mb-2">
          SOMETHING WENT WRONG
        </p>

        {/* Headline */}
        <h1 className="text-section-heading font-display text-ballot-ink">
          Votum could not complete this view.
        </h1>

        {/* Supporting copy */}
        <p className="text-body text-quiet-ink mt-2">
          Try again, or return to a stable part of the app.
        </p>

        {/* CTAs */}
        <div className="flex gap-3 mt-6">
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <Link
            href="/explore"
            className="text-body text-quiet-ink hover:text-ballot-ink transition-colors"
          >
            Go to Explore
          </Link>
        </div>
      </div>
    </div>
  );
}
