import type { OnboardingInputs, OnboardingIntent, OnboardingState } from "./types";

/**
 * V2B.1 onboarding state machine (pure).
 *
 * Derives the eight onboarding states from the existing Nimiq wallet provider
 * and VotumSessionProvider statuses. No parallel auth state is introduced —
 * this is a projection of the two existing providers, which keeps the
 * existing challenge → explicit signature → verify flow authoritative.
 */
export function deriveOnboardingState(input: OnboardingInputs): OnboardingState {
  const wallet = input.activeAccount?.trim().toLowerCase() ?? null;
  const verified = input.verifiedWalletAddress?.trim().toLowerCase() ?? null;

  // Explicit verification-flow statuses win over everything else.
  switch (input.sessionStatus) {
    case "requesting_challenge":
    case "awaiting_signature":
    case "verifying":
      return "verification_pending";
    case "permission_denied":
      return "rejected_cancelled";
    case "expired":
      return "expired";
    case "error":
      return "recoverable_failure";
    default:
      break;
  }

  // Verified session exists.
  if (input.sessionStatus === "verified") {
    if (wallet && wallet === verified) return "verified";
    if (!wallet) return "disconnected"; // reconnect the same wallet to resume
    return "connected_unverified";      // a different wallet is connected
  }
  if (input.sessionStatus === "verified_no_wallet") {
    if (!wallet) return "disconnected";
    return wallet === verified ? "verified" : "connected_unverified";
  }
  if (input.sessionStatus === "verified_wallet_mismatch") {
    return wallet ? "connected_unverified" : "disconnected";
  }

  // Session loading/unverified → wallet connection governs.
  if (input.walletStatus === "connecting") return "connecting";
  if (input.walletStatus === "error") return "recoverable_failure";
  if (input.walletStatus === "connected" && wallet) return "connected_unverified";
  return "disconnected";
}

/**
 * Destination for an intent after successful verification, or null when the
 * user stays on the current page (vote / create / generic_connect resume
 * reactively from isSessionVerified).
 */
export function resolveIntentPath(
  intent: OnboardingIntent,
  walletAddress: string,
): string | null {
  if (intent === "profile") return `/profile/${walletAddress}`;
  return null;
}
