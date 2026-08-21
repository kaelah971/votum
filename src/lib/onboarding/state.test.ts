import { describe, it, expect } from "vitest";
import { resolveIntentPath, deriveOnboardingState } from "@/lib/onboarding/state";

describe("resolveIntentPath", () => {
  it("builds a route-safe profile path from a spaced NQ wallet", () => {
    const path = resolveIntentPath(
      "profile",
      "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ",
    );
    expect(path).toBe("/profile/NQ47VGR3VVK0R49X98YGCNDYNST36CR5BCKQ");
  });

  it("returns null for non-profile intents", () => {
    expect(resolveIntentPath("generic_connect", "NQ47 VGR3")).toBeNull();
    expect(resolveIntentPath("vote", "NQ47 VGR3")).toBeNull();
    expect(resolveIntentPath("create_poll", "NQ47 VGR3")).toBeNull();
  });
});

describe("deriveOnboardingState — same-wallet reconnect", () => {
  const NQ = "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ";

  it("restores verified state when the same wallet reconnects", () => {
    expect(
      deriveOnboardingState({
        walletStatus: "connected",
        activeAccount: NQ,
        sessionStatus: "verified_no_wallet",
        verifiedWalletAddress: NQ,
        isInsideNimiqPay: true,
      }),
    ).toBe("verified");
  });

  it("restores verified state when the session returns the canonical NQ form", () => {
    // The /session endpoint returns the user-friendly NQ form; the connected
    // account may be spaced differently — canonical key must still match.
    expect(
      deriveOnboardingState({
        walletStatus: "connected",
        activeAccount: "NQ47VGR3VVK0R49X98YGCNDYNST36CR5BCKQ",
        sessionStatus: "verified_no_wallet",
        verifiedWalletAddress: NQ,
        isInsideNimiqPay: true,
      }),
    ).toBe("verified");
  });

  it("keeps connected-unverified when a different wallet reconnects", () => {
    expect(
      deriveOnboardingState({
        walletStatus: "connected",
        activeAccount: "NQ07 1111 1111 1111 1111 1111 1111 1111 1111",
        sessionStatus: "verified_no_wallet",
        verifiedWalletAddress: NQ,
        isInsideNimiqPay: true,
      }),
    ).toBe("connected_unverified");
  });

  it("treats a disconnected wallet as disconnected even with a verified session", () => {
    expect(
      deriveOnboardingState({
        walletStatus: "disconnected",
        activeAccount: null,
        sessionStatus: "verified_no_wallet",
        verifiedWalletAddress: NQ,
        isInsideNimiqPay: true,
      }),
    ).toBe("disconnected");
  });

  it("treats a verified wallet as unverified when no session exists", () => {
    // Profile existence alone must not grant verified state.
    expect(
      deriveOnboardingState({
        walletStatus: "connected",
        activeAccount: NQ,
        sessionStatus: "unverified",
        verifiedWalletAddress: null,
        isInsideNimiqPay: true,
      }),
    ).toBe("connected_unverified");
  });
});
