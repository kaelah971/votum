/**
 * V2B.1 — Onboarding controller and safe return-to-intent tests.
 *
 * Covers the pure onboarding state machine (derived from the existing
 * Nimiq/VotumSession providers), the strict internal return-path validator,
 * and intent resolution. The React provider glue is a thin projection of the
 * same pure functions and is verified by manual/device QA.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b1-onboarding-test.ts
 */

import { isSafeInternalReturnPath } from "@/lib/onboarding/return-path";
import { deriveOnboardingState, resolveIntentPath } from "@/lib/onboarding/state";
import type { OnboardingInputs } from "@/lib/onboarding/types";

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const WALLET_A = "01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "01bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Return-path validation
// ---------------------------------------------------------------------------

function testReturnPaths() {
  console.log("\n-- Return-path safety --");

  check(isSafeInternalReturnPath("/") === true, "accepts: home");
  check(isSafeInternalReturnPath("/explore") === true, "accepts: /explore");
  check(isSafeInternalReturnPath("/explore?category=sports") === true, "accepts: /explore with query");
  check(isSafeInternalReturnPath("/create") === true, "accepts: /create");
  check(isSafeInternalReturnPath("/how-it-works") === true, "accepts: /how-it-works");
  check(isSafeInternalReturnPath("/polls/2d09e346-56a2-4937-abff-4723fbe48efa") === true, "accepts: /polls/<id>");
  check(isSafeInternalReturnPath("/polls/abc?published=1") === true, "accepts: poll with query");
  check(isSafeInternalReturnPath("/my-polls") === true, "accepts: /my-polls");
  check(isSafeInternalReturnPath("/drafts") === true, "accepts: /drafts");
  check(isSafeInternalReturnPath("/insights") === true, "accepts: /insights");
  check(isSafeInternalReturnPath("/profile/edit") === true, "accepts: /profile/edit");
  check(isSafeInternalReturnPath("/profile/01ab") === true, "accepts: /profile/<wallet>");
  check(isSafeInternalReturnPath("/u/kaelah") === true, "accepts: /u/<handle>");

  check(isSafeInternalReturnPath("https://evil.example.com") === false, "rejects: absolute https URL");
  check(isSafeInternalReturnPath("http://evil.example.com") === false, "rejects: absolute http URL");
  check(isSafeInternalReturnPath("//evil.example.com") === false, "rejects: protocol-relative //");
  check(isSafeInternalReturnPath("javascript:alert(1)") === false, "rejects: javascript: scheme");
  check(isSafeInternalReturnPath("mailto:attacker@example.com") === false, "rejects: mailto scheme");
  check(isSafeInternalReturnPath("data:text/html,x") === false, "rejects: data: scheme");
  check(isSafeInternalReturnPath("/\\evil.example.com") === false, "rejects: leading slash-backslash");
  check(isSafeInternalReturnPath("/polls/abc\\evil") === false, "rejects: embedded backslash");
  check(isSafeInternalReturnPath("C:\\evil") === false, "rejects: windows path");
  check(isSafeInternalReturnPath("evil.example.com") === false, "rejects: no leading slash");
  check(isSafeInternalReturnPath("/evil") === false, "rejects: unsupported internal prefix");
  check(isSafeInternalReturnPath("/logout") === false, "rejects: unknown top-level route");
  check(isSafeInternalReturnPath("") === false, "rejects: empty string");
  check(isSafeInternalReturnPath(null) === false, "rejects: null");
  check(isSafeInternalReturnPath(undefined) === false, "rejects: undefined");
  check(isSafeInternalReturnPath("/explore:evil") === false, "rejects: colon anywhere");
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<OnboardingInputs> = {}): OnboardingInputs {
  return {
    walletStatus: "disconnected",
    activeAccount: null,
    sessionStatus: "unverified",
    verifiedWalletAddress: null,
    isInsideNimiqPay: true,
    ...overrides,
  };
}

function testStateMachine() {
  console.log("\n-- Onboarding state machine --");

  check(
    deriveOnboardingState(baseInputs()) === "disconnected",
    "no wallet, unverified → disconnected",
  );
  check(
    deriveOnboardingState(baseInputs({ walletStatus: "connecting" })) === "connecting",
    "wallet connecting → connecting",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "unverified",
    })) === "connected_unverified",
    "connected but unverified → connected_unverified",
  );

  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "requesting_challenge",
    })) === "verification_pending",
    "requesting_challenge → verification_pending",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "awaiting_signature",
    })) === "verification_pending",
    "awaiting_signature → verification_pending",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "verifying",
    })) === "verification_pending",
    "verifying → verification_pending",
  );

  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "verified",
      verifiedWalletAddress: WALLET_A,
    })) === "verified",
    "verified session + matching wallet → verified",
  );

  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "permission_denied",
    })) === "rejected_cancelled",
    "signature denied → rejected_cancelled",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "expired",
    })) === "expired",
    "session expired → expired",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "error",
    })) === "recoverable_failure",
    "session error → recoverable_failure",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "error",
      sessionStatus: "unverified",
    })) === "recoverable_failure",
    "wallet error → recoverable_failure",
  );

  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "disconnected",
      sessionStatus: "verified_no_wallet",
      verifiedWalletAddress: WALLET_A,
    })) === "disconnected",
    "verified session, wallet disconnected → disconnected",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_A,
      sessionStatus: "verified_no_wallet",
      verifiedWalletAddress: WALLET_A,
    })) === "verified",
    "reconnect matching wallet → verified without re-signing",
  );
  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_B,
      sessionStatus: "verified_no_wallet",
      verifiedWalletAddress: WALLET_A,
    })) === "connected_unverified",
    "different wallet reconnected → connected_unverified",
  );

  // Wallet switching with an active verified session.
  const switching = baseInputs({
    walletStatus: "connected",
    activeAccount: WALLET_A,
    sessionStatus: "verified",
    verifiedWalletAddress: WALLET_A,
  });
  check(deriveOnboardingState(switching) === "verified", "wallet switch base → verified");
  check(
    deriveOnboardingState({ ...switching, activeAccount: WALLET_B }) === "connected_unverified",
    "wallet switched mid-session → connected_unverified (new wallet needs its own verify)",
  );
  check(
    deriveOnboardingState({ ...switching, activeAccount: null }) === "disconnected",
    "wallet disconnected mid-session → disconnected",
  );

  check(
    deriveOnboardingState(baseInputs({
      walletStatus: "connected",
      activeAccount: WALLET_B,
      sessionStatus: "verified_wallet_mismatch",
      verifiedWalletAddress: WALLET_A,
    })) === "connected_unverified",
    "verified_wallet_mismatch → connected_unverified",
  );
}

// ---------------------------------------------------------------------------
// Intent resolution
// ---------------------------------------------------------------------------

function testIntentResolution() {
  console.log("\n-- Intent resolution --");

  check(
    resolveIntentPath("profile", WALLET_A) === `/profile/${WALLET_A}`,
    "profile intent → /profile/<wallet>",
  );
  check(resolveIntentPath("vote", WALLET_A) === null, "vote intent stays on page (panel resumes)");
  check(resolveIntentPath("create_poll", WALLET_A) === null, "create_poll intent stays on page");
  check(resolveIntentPath("generic_connect", WALLET_A) === null, "generic_connect stays on page");
}

// ---------------------------------------------------------------------------

function run() {
  console.log("V2B.1 Onboarding Suite");
  testReturnPaths();
  testStateMachine();
  testIntentResolution();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
