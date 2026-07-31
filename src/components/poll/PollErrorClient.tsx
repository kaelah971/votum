"use client";

import { ErrorState } from "@/components/state/ErrorState";

/**
 * Thin client-side wrapper around ErrorState so the server-rendered poll
 * detail page can offer a "Try again" button that triggers a page reload.
 */
export function PollErrorClient() {
  return (
    <ErrorState
      title="Could not load this poll"
      description="Something went wrong while fetching this poll. Please try again."
      onRetry={() => window.location.reload()}
    />
  );
}
