"use client";

import { useCallback, useEffect, useRef } from "react";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { Button } from "@/components/ui/Button";
import { WalletIconLarge, CheckIcon, CloseIcon } from "@/components/ui/icons";

/**
 * Wrap an async action for use as a DOM event handler so the returned promise
 * can never reject and surface as an unhandled rejection (e.g. Next's dev
 * overlay `onUnhandledRejection` showing "[object Object]" for a plain-object
 * Nimiq Pay cancellation). React does not await event-handler promises; a
 * rejecting handler promise would otherwise escape to the window.
 */
function safeClick(handler: () => void | Promise<unknown>) {
  return () => {
    Promise.resolve()
      .then(handler)
      .catch(() => {
        /* never propagate to window */
      });
  };
}

/**
 * V2B.1 shared wallet onboarding surface.
 *
 * Renders the eight onboarding states as a modal (desktop) / bottom sheet
 * (mobile). Consumes ONLY the OnboardingProvider controller state — no
 * parallel auth/session logic exists here. Signing stays an explicit user
 * action: verification is never auto-triggered by connecting a wallet.
 */

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="28"
        strokeDashoffset="8"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

interface StatePanelProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  busy?: boolean;
}

function StatePanel({ icon, title, description, action, busy = false }: StatePanelProps) {
  return (
    <div
      className="flex flex-col items-center px-2 py-4 text-center"
      role="status"
      aria-live="polite"
      aria-busy={busy}
    >
      <div className="mb-5 text-signal-gold opacity-80">{icon}</div>
      <h2 id="onboarding-title" className="text-section-heading font-display text-ballot-ink">
        {title}
      </h2>
      <p className="mt-2 max-w-sm text-body text-quiet-ink">{description}</p>
      {action && <div className="mt-6 flex flex-col items-center gap-2">{action}</div>}
    </div>
  );
}

export function WalletOnboardingSheet() {
  const { open, state, profileReady, closeOnboarding } = useOnboarding();
  const { walletStatus, connectWallet } = useNimiqContext();
  const { verifyActiveWallet } = useVotumSession();

  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // States where closing is allowed (transient flows — connecting, pending
  // signature, verified — intentionally block dismissal).
  const closable =
    state === "disconnected" ||
    state === "connected_unverified" ||
    state === "rejected_cancelled" ||
    state === "expired" ||
    state === "recoverable_failure";

  // Focus the primary action when the sheet opens; keep it in the dialog.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      primaryRef.current?.focus();
      panelRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, state]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && closable) closeOnboarding();
      if (event.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    [closable, closeOnboarding],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  const closeButton = closable ? (
    <button
      type="button"
      onClick={closeOnboarding}
      aria-label="Close"
      className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full text-quiet-ink hover:bg-soft-fog hover:text-ballot-ink transition-colors"
    >
      <CloseIcon className="w-4 h-4" />
    </button>
  ) : null;

  let panel: React.ReactNode = null;

  switch (state) {
    case "disconnected":
      panel = (
        <StatePanel
          icon={<WalletIconLarge />}
          title="Connect your wallet"
          description="Connect your Nimiq wallet to continue."
          action={
            <Button ref={primaryRef} type="button" variant="primary" onClick={safeClick(connectWallet)}>
              Connect wallet
            </Button>
          }
        />
      );
      break;

    case "connecting":
      panel = (
        <StatePanel
          busy
          icon={<Spinner />}
          title="Connecting…"
          description="Connecting to your Nimiq wallet."
        />
      );
      break;

    case "connected_unverified":
      panel = (
        <StatePanel
          icon={<WalletIconLarge />}
          title="Verify wallet ownership"
          description="Wallet connected. Verify ownership to participate on Votum."
          action={
            <Button ref={primaryRef} type="button" variant="primary" onClick={safeClick(verifyActiveWallet)}>
              Verify wallet ownership
            </Button>
          }
        />
      );
      break;

    case "verification_pending":
      panel = (
        <StatePanel
          busy
          icon={<Spinner />}
          title="Waiting for your signature…"
          description="Sign the verification request in Nimiq Pay to prove you own this wallet."
        />
      );
      break;

    case "verified":
      panel = (
        <StatePanel
          busy
          icon={<CheckIcon className="w-10 h-10" />}
          title="You're verified."
          description={
            profileReady
              ? "Your Votum profile is ready. Add a name or handle anytime."
              : "Continuing to your next step…"
          }
        />
      );
      break;

    case "rejected_cancelled":
      panel = (
        <StatePanel
          icon={<WalletIconLarge />}
          title="Verification cancelled"
          description="Verification wasn't completed. Try again."
          action={
            <Button ref={primaryRef} type="button" variant="primary" onClick={safeClick(verifyActiveWallet)}>
              Try again
            </Button>
          }
        />
      );
      break;

    case "expired":
      panel = (
        <StatePanel
          icon={<WalletIconLarge />}
          title="Verification expired"
          description="Verification expired. Start again."
          action={
            <Button ref={primaryRef} type="button" variant="primary" onClick={safeClick(verifyActiveWallet)}>
              Start again
            </Button>
          }
        />
      );
      break;

    case "recoverable_failure":
      panel = (
        <StatePanel
          icon={<WalletIconLarge />}
          title="Something went wrong"
          description="We couldn't verify your wallet right now. Try again."
          action={
            <Button
              ref={primaryRef}
              type="button"
              variant="primary"
              onClick={
                walletStatus === "connected"
                  ? safeClick(verifyActiveWallet)
                  : safeClick(connectWallet)
              }
            >
              Try again
            </Button>
          }
        />
      );
      break;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center" role="presentation">
      <div
        className="absolute inset-0 bg-ballot-ink/20 backdrop-blur-sm"
        onClick={closable ? closeOnboarding : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
        className="relative w-full max-h-[88vh] overflow-y-auto bg-clear-ballot border border-divider rounded-t-overlay sm:rounded-overlay shadow-card p-6 sm:max-w-md"
      >
        {closeButton}
        {panel}
      </div>
    </div>
  );
}
