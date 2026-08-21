"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { truncateAddress } from "@/lib/format";
import { WalletIcon, CheckIcon } from "@/components/ui/icons";

export function WalletButton() {
  const {
    runtimeStatus,
    walletStatus,
    accounts,
    activeAccount,
    connectWallet,
    disconnectWallet,
    setActiveAccount,
    retryInit,
    error,
  } = useNimiqContext();

  const {
    status: sessionStatus,
    verifiedWalletAddress,
    endVerifiedSession,
    isSessionVerified,
    isWalletMatched,
  } = useVotumSession();

  const { openOnboarding } = useOnboarding();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when the user clicks outside.
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // ------------------------------------------------------------------
  // Runtime: initializing (or idle – the split-second before INIT_START)
  // ------------------------------------------------------------------
  if (runtimeStatus === "initializing" || runtimeStatus === "idle") {
    return (
      <div className="flex min-h-[44px] items-center rounded-full border border-border bg-clear-ballot/45 px-3 backdrop-blur">
        <Spinner className="text-quiet-ink sm:mr-2" />
        <span className="hidden text-secondary text-quiet-ink sm:inline">
          Connecting to Nimiq Pay...
        </span>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Runtime: unavailable – user is not inside Nimiq Pay
  // ------------------------------------------------------------------
  if (runtimeStatus === "unavailable") {
    return (
      <div className="flex flex-col items-start">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="inline-flex min-h-[44px] items-center rounded-full border border-border bg-clear-ballot/55 px-3 py-2 text-sm font-medium text-micro-grey"
        >
          <WalletIcon className="opacity-50 sm:mr-2" />
          <span className="hidden sm:inline">Nimiq Pay required</span>
        </button>
        <p className="text-micro text-quiet-ink mt-1">
          Open Votum in Nimiq Pay to connect your wallet.
        </p>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Runtime: error – the SDK failed to initialise entirely
  // ------------------------------------------------------------------
  if (runtimeStatus === "error") {
    return (
      <div className="flex flex-col items-start">
        <span className="text-micro text-reject-red">
          Connection unavailable
        </span>
        <button
          type="button"
          onClick={() => retryInit()}
          className="text-micro text-quiet-ink underline underline-offset-2 hover:text-ballot-ink transition-colors cursor-pointer mt-0.5"
        >
          Retry
        </button>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: disconnected – runtime is available, but no accounts yet
  // ------------------------------------------------------------------
  if (walletStatus === "disconnected") {
    return (
      <button
        type="button"
        onClick={() => openOnboarding({ intent: "generic_connect" })}
        aria-label="Connect wallet"
        className="inline-flex min-h-[44px] items-center rounded-full border border-ballot-ink/18 bg-clear-ballot/45 px-3 py-2 text-sm font-medium text-ballot-ink backdrop-blur transition-colors hover:bg-clear-ballot/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2"
      >
        <WalletIcon className="sm:mr-2" />
        <span className="hidden sm:inline">Connect wallet</span>
      </button>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: connecting – listAccounts() is in-flight
  // ------------------------------------------------------------------
  if (walletStatus === "connecting") {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="inline-flex min-h-[44px] items-center rounded-full border border-border bg-clear-ballot/55 px-3 py-2 text-sm font-medium text-quiet-ink"
      >
        <Spinner className="sm:mr-2" />
        <span className="hidden sm:inline">Connecting...</span>
      </button>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: connected – show truncated address + account dropdown
  // ------------------------------------------------------------------
  if (walletStatus === "connected") {
    const truncated = activeAccount ? truncateAddress(activeAccount) : "N/A";

    return (
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label="Wallet account menu"
          aria-expanded={menuOpen}
          className="inline-flex min-h-[44px] items-center rounded-full border border-ballot-ink/18 bg-clear-ballot/45 px-3 py-2 text-sm font-medium text-nim-blue backdrop-blur transition-colors hover:bg-clear-ballot/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2 max-w-[130px]"
        >
          <span className="font-proof truncate min-w-0">{truncated}</span>
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden="true"
            className={`ml-2 transition-transform ${menuOpen ? "rotate-180" : ""}`}
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.25rem)] bg-clear-ballot rounded-overlay border border-divider shadow-card p-3 z-50">
            <p className="text-micro text-quiet-ink mb-2">Connected account</p>

            {/* Wallet mismatch warning: active wallet differs from verified session */}
            {(sessionStatus === "verified_wallet_mismatch" ||
              (sessionStatus === "verified" &&
                verifiedWalletAddress &&
                activeAccount &&
                activeAccount.trim().toLowerCase() !==
                  verifiedWalletAddress.trim().toLowerCase())) && (
                <p className="text-micro text-fairness-amber mb-2">
                  Active wallet differs from verified session
                </p>
              )}

            <ul className="space-y-0.5">
              {accounts.map((account) => {
                const isActive = account === activeAccount;
                return (
                  <li key={account}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveAccount(account);
                        setMenuOpen(false);
                      }}
                      className={`w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm transition-colors cursor-pointer ${
                        isActive
                          ? "bg-signal-gold/[0.08]"
                          : "hover:bg-soft-fog"
                      }`}
                    >
                      {isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-signal-gold mr-2 shrink-0" />
                      )}
                      <span
                        className={`font-proof truncate min-w-0 ${isActive ? "text-ballot-ink" : "text-quiet-ink"}`}
                      >
                        {account}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <hr className="my-2 border-divider" />

            {/* Verified account actions */}
            {isSessionVerified && isWalletMatched && verifiedWalletAddress && (
              <ul className="space-y-0.5">
                <li>
                  <Link
                    href={`/profile/${verifiedWalletAddress}`}
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm text-ballot-ink hover:bg-soft-fog transition-colors"
                  >
                    View profile
                  </Link>
                </li>
                <li>
                  <Link
                    href="/profile/edit"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm text-quiet-ink hover:bg-soft-fog hover:text-ballot-ink transition-colors"
                  >
                    Edit profile
                  </Link>
                </li>
                <li>
                  <Link
                    href="/my-polls"
                    onClick={() => setMenuOpen(false)}
                    className="w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm text-quiet-ink hover:bg-soft-fog hover:text-ballot-ink transition-colors"
                  >
                    My polls
                  </Link>
                </li>
              </ul>
            )}

            {/* Connected-but-unverified: clear verify action */}
            {walletStatus === "connected" && !isSessionVerified && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openOnboarding({ intent: "generic_connect" });
                }}
                className="w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm text-signal-gold font-medium hover:bg-soft-fog transition-colors cursor-pointer"
              >
                Verify this wallet
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                disconnectWallet();
                setMenuOpen(false);
              }}
              className="w-full text-left inline-flex items-center min-h-[44px] px-3 py-2 rounded-thumbnail text-sm text-quiet-ink hover:bg-soft-fog hover:text-reject-red transition-colors cursor-pointer"
            >
              Disconnect from Votum
            </button>

            {/* Session status */}
            {isSessionVerified && (
              <>
                <div className="border-t border-divider mt-2" />
                <div className="px-3 py-2">
                  {isWalletMatched ? (
                    <p className="text-micro text-verified-green font-medium flex items-center gap-1">
                      <CheckIcon className="w-3 h-3" />
                      Session verified
                    </p>
                  ) : sessionStatus === "verified_wallet_mismatch" ? (
                    <p className="text-micro text-fairness-amber font-medium">
                      Wallet does not match verified session
                    </p>
                  ) : (
                    <p className="text-micro text-quiet-ink font-medium">
                      Session active — reconnect wallet
                    </p>
                  )}
                </div>
                <div className="border-t border-divider" />
                <button
                  type="button"
                  onClick={() => {
                    endVerifiedSession();
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-quiet-ink hover:text-ballot-ink hover:bg-soft-fog transition-colors rounded-thumbnail cursor-pointer"
                >
                  End verified Votum session
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: permission_denied
  // ------------------------------------------------------------------
  if (walletStatus === "permission_denied") {
    return (
      <div className="flex flex-col items-start">
        <span className="text-micro text-reject-red">Access denied</span>
        <button
          type="button"
          onClick={connectWallet}
          className="text-micro text-quiet-ink underline underline-offset-2 hover:text-ballot-ink transition-colors cursor-pointer mt-0.5 text-left"
        >
          Wallet access was not approved. Tap to try again.
        </button>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: no_accounts
  // ------------------------------------------------------------------
  if (walletStatus === "no_accounts") {
    return (
      <button
        type="button"
        onClick={connectWallet}
        className="text-micro text-quiet-ink underline underline-offset-2 hover:text-ballot-ink transition-colors cursor-pointer text-left min-h-[44px] inline-flex items-center"
      >
        No Nimiq account was available. Tap to try again.
      </button>
    );
  }

  // ------------------------------------------------------------------
  // Wallet: error
  // ------------------------------------------------------------------
  if (walletStatus === "error") {
    return (
      <div className="flex flex-col items-start">
        <span className="text-micro text-reject-red">Wallet error</span>
        <button
          type="button"
          onClick={connectWallet}
          className="text-micro text-quiet-ink underline underline-offset-2 hover:text-ballot-ink transition-colors cursor-pointer mt-0.5 text-left"
        >
          {error ?? "Wallet connection failed. Tap to retry."}
        </button>
      </div>
    );
  }

  // Fallback — should not be reachable once all states are covered.
  return null;
}

// ---------------------------------------------------------------------------
// Small inline loading spinner shared across several states.
// ---------------------------------------------------------------------------
function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="16"
      height="16"
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
