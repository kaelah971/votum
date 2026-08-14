/**
 * V2B.1 onboarding controller contracts.
 *
 * One shared onboarding surface serves every wallet connect/verify flow.
 * `OnboardingState` is the eight-state machine; `OnboardingIntent` records WHY
 * verification was required so the user is returned to their action instead
 * of being dumped into My Polls.
 */

export type OnboardingIntent =
  | "generic_connect"
  | "vote"
  | "create_poll"
  | "profile";

export type OnboardingState =
  | "disconnected"
  | "connecting"
  | "connected_unverified"
  | "verification_pending"
  | "verified"
  | "rejected_cancelled"
  | "expired"
  | "recoverable_failure";

/** Inputs consumed by the pure state-derivation function. */
export interface OnboardingInputs {
  walletStatus: string;
  activeAccount: string | null;
  sessionStatus: string;
  verifiedWalletAddress: string | null;
  isInsideNimiqPay: boolean;
}

/** What was requested when onboarding was opened. */
export interface OnboardingRequest {
  intent: OnboardingIntent;
  /** Validated internal return path (always safe; may be the current page). */
  returnPath: string;
}
