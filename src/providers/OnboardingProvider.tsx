"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { deriveOnboardingState, resolveIntentPath } from "@/lib/onboarding/state";
import { isSafeInternalReturnPath } from "@/lib/onboarding/return-path";
import type { OnboardingIntent, OnboardingRequest, OnboardingState } from "@/lib/onboarding/types";

interface OnboardingContextValue {
  /** True when the shared onboarding surface should be shown. */
  open: boolean;
  state: OnboardingState;
  intent: OnboardingIntent | null;
  /** Wallet address of the verified session when `state` is verified. */
  verifiedWalletAddress: string | null;
  /** True once the post-verification profile bootstrap succeeded once. */
  profileReady: boolean;
  openOnboarding: (request?: { intent?: OnboardingIntent; returnPath?: string }) => void;
  closeOnboarding: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * V2B.1 onboarding controller.
 *
 * Projects the existing Nimiq + VotumSession providers into the eight-state
 * onboarding machine, reuses connectWallet()/verifyActiveWallet(), bootstraps
 * the participant profile once per verified wallet, and resolves the intent
 * exactly once (stale intents never fire on later renders or reconnects).
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const nimiq = useNimiqContext();
  const session = useVotumSession();

  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<OnboardingIntent | null>(null);
  const [profileReady, setProfileReady] = useState(false);

  // One-shot guards: a resolved intent never fires again, and bootstrap runs
  // once per wallet for the lifetime of this provider.
  const handledRef = useRef(true);
  const bootstrappedRef = useRef<string | null>(null);
  const requestRef = useRef<OnboardingRequest | null>(null);

  const state = useMemo<OnboardingState>(
    () =>
      deriveOnboardingState({
        walletStatus: nimiq.walletStatus,
        activeAccount: nimiq.activeAccount,
        sessionStatus: session.status,
        verifiedWalletAddress: session.verifiedWalletAddress,
        isInsideNimiqPay: nimiq.isInsideNimiqPay,
      }),
    [
      nimiq.walletStatus,
      nimiq.activeAccount,
      nimiq.isInsideNimiqPay,
      session.status,
      session.verifiedWalletAddress,
    ],
  );

  const openOnboarding = useCallback(
    (request?: { intent?: OnboardingIntent; returnPath?: string }) => {
      const candidate = request?.returnPath;
      const returnPath: string = isSafeInternalReturnPath(candidate)
        ? candidate
        : (pathname ?? "/");
      const requestState: OnboardingRequest = {
        intent: request?.intent ?? "generic_connect",
        returnPath,
      };
      requestRef.current = requestState;
      handledRef.current = false;
      setIntent(requestState.intent);
      setOpen(true);
    },
    [pathname],
  );

  const closeOnboarding = useCallback(() => {
    handledRef.current = true;
    requestRef.current = null;
    setOpen(false);
    setIntent(null);
  }, []);

  // One-shot resolution on verified: bootstrap once, then resolve the intent.
  useEffect(() => {
    if (!open || handledRef.current) return;
    if (state !== "verified") return;

    handledRef.current = true;
    const request = requestRef.current;
    const wallet = session.verifiedWalletAddress;

    void (async () => {
      if (wallet && bootstrappedRef.current !== wallet) {
        bootstrappedRef.current = wallet;
        try {
          const res = await fetch("/api/profile/bootstrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          setProfileReady(res.ok);
        } catch {
          setProfileReady(false);
        }
      }

      const target = wallet ? resolveIntentPath(request?.intent ?? "generic_connect", wallet) : null;
      requestRef.current = null;
      setOpen(false);
      setIntent(null);

      if (target) {
        router.push(target);
      }
    })();
  }, [open, state, session.verifiedWalletAddress, router]);

  const contextValue = useMemo<OnboardingContextValue>(
    () => ({
      open,
      state,
      intent,
      verifiedWalletAddress: session.verifiedWalletAddress,
      profileReady,
      openOnboarding,
      closeOnboarding,
    }),
    [open, state, intent, session.verifiedWalletAddress, profileReady, openOnboarding, closeOnboarding],
  );

  return (
    <OnboardingContext.Provider value={contextValue}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboarding must be used within OnboardingProvider");
  }
  return ctx;
}
