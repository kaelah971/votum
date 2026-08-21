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
import { useNimiqContext } from "@/providers/NimiqProvider";
import { canonicalWalletKey } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus =
  | "loading"
  | "unverified"
  | "verified_no_wallet"       // verified session exists, no wallet connected
  | "verified_wallet_mismatch"  // verified session exists, different wallet connected
  | "requesting_challenge"
  | "awaiting_signature"
  | "verifying"
  | "verified"                 // verified + matching wallet connected
  | "permission_denied"
  | "expired"
  | "error";

interface VotumSessionState {
  status: SessionStatus;
  verifiedWalletAddress: string | null;
  error: string | null;
}

interface VotumSessionContextValue extends VotumSessionState {
  verifyActiveWallet: () => Promise<void>;
  endVerifiedSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  /** True when a verified session exists (any verified* status). */
  isSessionVerified: boolean;
  /** True when the connected wallet matches the verified session. */
  isWalletMatched: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const VotumSessionContext = createContext<VotumSessionContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function VotumSessionProvider({ children }: { children: ReactNode }) {
  const { provider, activeAccount, isInsideNimiqPay } = useNimiqContext();
  const [state, setState] = useState<VotumSessionState>({
    status: "loading",
    verifiedWalletAddress: null,
    error: null,
  });

  // Refs to keep the latest activeAccount accessible inside stable callbacks.
  const activeAccountRef = useRef(activeAccount);
  useEffect(() => {
    activeAccountRef.current = activeAccount;
  });

  // ---- Refresh: check the current session cookie via GET /api/wallet-proof/session ----
  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet-proof/session");
      const data = await res.json();
      if (data.verified) {
        const currentAccount = activeAccountRef.current;
        const verifiedAddr = (data.walletAddress as string).trim().toLowerCase();
        if (
          currentAccount &&
          canonicalWalletKey(currentAccount) === canonicalWalletKey(verifiedAddr)
        ) {
          setState({
            status: "verified",
            verifiedWalletAddress: data.walletAddress,
            error: null,
          });
        } else {
          setState({
            status: "verified_no_wallet",
            verifiedWalletAddress: data.walletAddress,
            error: null,
          });
        }
      } else {
        setState({
          status: "unverified",
          verifiedWalletAddress: null,
          error: null,
        });
      }
    } catch {
      setState({
        status: "unverified",
        verifiedWalletAddress: null,
        error: null,
      });
    }
  }, []);

  // Refresh session on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/wallet-proof/session");
        if (cancelled) return;
        const data = await res.json();
        if (data.verified) {
          const currentAccount = activeAccountRef.current;
          const verifiedAddr = (data.walletAddress as string).trim().toLowerCase();
          if (
            currentAccount &&
            canonicalWalletKey(currentAccount) === canonicalWalletKey(verifiedAddr)
          ) {
            setState({
              status: "verified",
              verifiedWalletAddress: data.walletAddress,
              error: null,
            });
          } else {
            setState({
              status: "verified_no_wallet",
              verifiedWalletAddress: data.walletAddress,
              error: null,
            });
          }
        } else {
          setState({
            status: "unverified",
            verifiedWalletAddress: null,
            error: null,
          });
        }
      } catch {
        if (!cancelled) {
          setState({ status: "unverified", verifiedWalletAddress: null, error: null });
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // -----------------------------------------------------------------------
  // verifyActiveWallet — full challenge → sign → verify flow
  // -----------------------------------------------------------------------
  const verifyActiveWallet = useCallback(async () => {
    if (!provider || !activeAccount) {
      setState((prev) => ({ ...prev, error: "No wallet connected" }));
      return;
    }

    try {
      setState((prev) => ({
        ...prev,
        status: "requesting_challenge",
        error: null,
      }));

      // Step 1: Request a one-time challenge from the server.
      const challengeRes = await fetch("/api/wallet-proof/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: activeAccount }),
      });

      if (!challengeRes.ok) {
        const errData = await challengeRes.json().catch(() => ({}));
        const stage = errData.stage || "challenge";
        const requestId = errData.requestId || "unknown";
        const message = errData.message || errData.error || "Failed to create challenge";
        setState({
          status: "error",
          verifiedWalletAddress: null,
          error: `[${stage}] ${message} (ref: ${requestId})`,
        });
        return;
      }

      const { challengeId, message } = await challengeRes.json();
      setState((prev) => ({ ...prev, status: "awaiting_signature" }));

      // Step 2: Request a cryptographic signature from Nimiq Pay.
      const { signMessage } = await import("@/lib/nimiq/client");
      const signResult = await signMessage(provider, message);

      if ("denied" in signResult) {
        setState({
          status: "permission_denied",
          verifiedWalletAddress: null,
          error: null,
        });
        return;
      }
      if ("error" in signResult) {
        setState({
          status: "error",
          verifiedWalletAddress: null,
          error: signResult.error,
        });
        return;
      }

      setState((prev) => ({ ...prev, status: "verifying" }));

      // Step 3: Send the signature to the server for verification.
      const verifyRes = await fetch("/api/wallet-proof/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId,
          address: activeAccount,
          publicKey: signResult.publicKey,
          signature: signResult.signature,
        }),
      });

      if (!verifyRes.ok) {
        const errData = await verifyRes.json().catch(() => ({}));
        const errorMsg = errData.message || errData.error || "Verification failed";
        setState({
          status: "error",
          verifiedWalletAddress: null,
          error: errorMsg,
        });
        return;
      }

      const verifyData = await verifyRes.json();
      setState({
        status: "verified",
        verifiedWalletAddress: verifyData.walletAddress,
        error: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Verification error";
      setState({
        status: "error",
        verifiedWalletAddress: null,
        error: msg,
      });
    }
  }, [provider, activeAccount]);

  // -----------------------------------------------------------------------
  // endVerifiedSession — revoke the server-side session
  // -----------------------------------------------------------------------
  const endVerifiedSession = useCallback(async () => {
    await fetch("/api/wallet-proof/logout", { method: "POST" });
    setState({
      status: "unverified",
      verifiedWalletAddress: null,
      error: null,
    });
  }, []);

  // -----------------------------------------------------------------------
  // Watch activeAccount changes to transition between verified sub-states.
  // When a verified session exists but the wallet connects / disconnects /
  // changes, update the status accordingly without requiring a new signature.
  // -----------------------------------------------------------------------
  useEffect(() => {
    // Only relevant when a verified session cookie exists.
    if (!state.verifiedWalletAddress) return;

    const normalizedVerified = canonicalWalletKey(state.verifiedWalletAddress);

    if (!activeAccount) {
      // Wallet disconnected — session persists, but no wallet is connected.
      if (
        state.status === "verified" ||
        state.status === "verified_wallet_mismatch"
      ) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState((prev) => ({ ...prev, status: "verified_no_wallet" }));
      }
    } else {
      const normalizedActive = canonicalWalletKey(activeAccount);
      const matches = normalizedActive === normalizedVerified;

      if (state.status === "verified_no_wallet" && matches) {
        setState((prev) => ({ ...prev, status: "verified" }));
      } else if (state.status === "verified_no_wallet" && !matches) {
        setState((prev) => ({ ...prev, status: "verified_wallet_mismatch" }));
      } else if (state.status === "verified" && !matches) {
        setState((prev) => ({ ...prev, status: "verified_wallet_mismatch" }));
      } else if (state.status === "verified_wallet_mismatch" && matches) {
        setState((prev) => ({ ...prev, status: "verified" }));
      }
    }
  }, [activeAccount, state.verifiedWalletAddress, state.status]);

  // Suppress unused variable warning — isInsideNimiqPay may be used by
  // future session logic (e.g., auto-clear on leaving Nimiq Pay).
  void isInsideNimiqPay;

  const contextValue = useMemo<VotumSessionContextValue>(
    () => ({
      ...state,
      verifyActiveWallet,
      endVerifiedSession,
      refreshSession,
      isSessionVerified: state.status.startsWith("verified"),
      isWalletMatched: state.status === "verified",
    }),
    [state, verifyActiveWallet, endVerifiedSession, refreshSession],
  );

  return (
    <VotumSessionContext.Provider value={contextValue}>
      {children}
    </VotumSessionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVotumSession(): VotumSessionContextValue {
  const ctx = useContext(VotumSessionContext);
  if (!ctx) {
    throw new Error(
      "useVotumSession must be used within VotumSessionProvider",
    );
  }
  return ctx;
}
