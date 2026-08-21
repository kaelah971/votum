"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { profileWalletPath } from "@/lib/profiles/path";

/**
 * V2B.1 in-app account/profile actions for the product navigation drawer.
 *
 * Reuses the same session truth and onboarding controller as WalletButton —
 * no duplicate identity implementation. Displays the canonical profile actions
 * (View profile / Edit profile) for a verified, matched session; a
 * "Verify this wallet" action when connected-but-unverified; and a Connect
 * wallet action when disconnected.
 */
export function ProductNavAccountActions() {
  const { walletStatus } = useNimiqContext();
  const {
    isSessionVerified,
    isWalletMatched,
    verifiedWalletAddress,
  } = useVotumSession();
  const { openOnboarding } = useOnboarding();

  const verified =
    isSessionVerified && isWalletMatched && verifiedWalletAddress;

  const openGenericConnect = useCallback(() => {
    openOnboarding({ intent: "generic_connect" });
  }, [openOnboarding]);

  return (
    <div className="space-y-1">
      {verified ? (
        <>
          <Link
            href={`/profile/${profileWalletPath(verifiedWalletAddress)}`}
            className="flex items-center min-h-[48px] px-4 rounded-full text-body font-medium text-ballot-ink hover:bg-soft-fog transition-colors"
          >
            View profile
          </Link>
          <Link
            href="/profile/edit"
            className="flex items-center min-h-[48px] px-4 rounded-full text-body font-medium text-ballot-ink hover:bg-soft-fog transition-colors"
          >
            Edit profile
          </Link>
        </>
      ) : (
        <button
          type="button"
          onClick={openGenericConnect}
          className="w-full text-left flex items-center min-h-[48px] px-4 rounded-full text-body font-medium text-signal-gold hover:bg-soft-fog transition-colors cursor-pointer"
        >
          {walletStatus === "connected" ? "Verify this wallet" : "Connect wallet"}
        </button>
      )}
    </div>
  );
}
