"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { Button } from "@/components/ui/Button";
import { WalletIconLarge } from "@/components/ui/icons";

/**
 * V2B.1 create-entry gate.
 *
 * The create form is only usable once the user's wallet is connected AND
 * ownership-verified (verified session). Disconnected and connected-but-
 * unverified visitors get an explicit gate that opens the shared onboarding
 * with the `create_poll` intent; after signing they return to /create and the
 * form becomes available. Verification is never auto-signed.
 */
export function CreateGate() {
  const { walletStatus } = useNimiqContext();
  const { isSessionVerified, isWalletMatched } = useVotumSession();
  const { openOnboarding } = useOnboarding();
  const pathname = usePathname();

  const verified = isSessionVerified && isWalletMatched;
  const connectedUnverified = walletStatus === "connected" && !verified;

  const beginCreate = useCallback(() => {
    openOnboarding({ intent: "create_poll", returnPath: pathname });
  }, [openOnboarding, pathname]);

  // Verified creators never see the gate — the page renders the form.
  if (verified) return null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center rounded-[24px] border border-white/75 bg-clear-ballot/64 px-5 py-16 text-center shadow-card backdrop-blur">
      <div className="mb-6 text-signal-gold opacity-80">
        <WalletIconLarge />
      </div>
      <h2 className="text-section-heading font-display text-ballot-ink">
        {connectedUnverified
          ? "Verify wallet ownership to create"
          : "Connect your wallet to create"}
      </h2>
      <p className="mt-3 max-w-sm text-body text-quiet-ink">
        {connectedUnverified
          ? "Your wallet is connected but not yet verified. Verify ownership to build and publish a Votum poll."
          : "Connect your Nimiq wallet and verify ownership to build and publish a Votum poll."}
      </p>
      <div className="mt-8">
        <Button type="button" variant="primary" onClick={beginCreate}>
          {connectedUnverified ? "Verify wallet ownership" : "Connect wallet"}
        </Button>
      </div>
    </div>
  );
}
