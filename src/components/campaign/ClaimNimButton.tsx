"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { useCampaignClaim, type CampaignClaimReceipt, type ClaimPhase } from "@/hooks/useCampaignClaim";
import { useVotumSession } from "@/providers/VotumSessionProvider";

const PHASE_LABEL: Record<Extract<ClaimPhase, "requesting_challenge" | "awaiting_signature" | "submitting_claim">, string> = {
  requesting_challenge: "Requesting claim challenge",
  awaiting_signature: "Confirm in your wallet",
  submitting_claim: "Reserving your reward",
};

const ERROR_COPY: Record<string, string> = {
  session_missing: "Connect and verify your wallet to claim.",
  invalid_request: "This claim request is incomplete.",
  invalid_origin: "This claim request is incomplete.",
  signature_rejected: "Signature rejected in your wallet.",
  signature_failed: "Wallet signing failed.",
  wallet_mismatch: "Active wallet does not match this claim.",
  campaign_mismatch: "This claim belongs to another campaign.",
  invalid_signature: "This signature is not valid.",
  challenge_invalid: "This claim request is no longer valid.",
  challenge_expired: "This claim request expired.",
  challenge_consumed: "This claim request was already used.",
  campaign_not_found: "Campaign not found.",
  unsupported_type: "This campaign type cannot be claimed.",
  campaign_not_published: "This campaign is not available.",
  campaign_closed: "Closed",
  not_published: "This campaign is not available.",
  closed: "Closed",
  not_started: "Not started yet",
  claim_not_started: "Not started yet",
  ended: "Ended",
  claim_ended: "Ended",
  funding_pending: "Funding pending",
  campaign_not_funded: "Funding pending",
  creator_ineligible: "Not eligible",
  creator_not_eligible: "Not eligible",
  sold_out: "Sold out",
  no_reward_capacity: "Sold out",
  claim_failed: "Claim failed.",
};

function errorCopy(code: string | null): string {
  if (!code) return "Claim failed.";
  return ERROR_COPY[code] ?? "Claim failed.";
}

interface ClaimNimButtonProps {
  campaignId: string;
  className?: string;
  /**
   * Fired once per successful claim (new or replay) so a parent can
   * coordinate follow-up reads. Optional; the button behaves identically
   * without it.
   */
  onClaimed?: (receipt: CampaignClaimReceipt) => void;
}

/**
 * Canonical Claim NIM action. Renders the Signal Gold single CTA while the
 * claim is actionable, a loading label per flow phase, a non-destructive
 * success state (reservation copy, Verified Green only for Paid), and a
 * deterministic error with a safe restart. Never renders payout retry,
 * resend, or broadcast controls.
 */
export function ClaimNimButton({ campaignId, className = "", onClaimed }: ClaimNimButtonProps) {
  const { phase, receipt, errorCode, start, reset } = useCampaignClaim(campaignId);
  const { isSessionVerified, isWalletMatched } = useVotumSession();
  const sessionReady = isSessionVerified && isWalletMatched;
  const onClaimedRef = useRef(onClaimed);
  useEffect(() => {
    onClaimedRef.current = onClaimed;
  }, [onClaimed]);
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase === "done" && receipt && notifiedRef.current !== receipt.receiptId) {
      notifiedRef.current = receipt.receiptId;
      onClaimedRef.current?.(receipt);
    }
    if (phase !== "done") {
      notifiedRef.current = null;
    }
  }, [phase, receipt]);

  if (phase === "done" && receipt) {
    const isPaid = receipt.status === "paid";
    const title = receipt.replayed ? "Already reserved" : isPaid ? "Paid" : "Reward reserved";
    return (
      <div className={`space-y-2 ${className}`}>
        <p className={`flex items-center gap-2 text-body font-medium ${isPaid ? "text-verified-green" : "text-ballot-ink"}`}>
          {isPaid ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0">
              <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
          {title}
        </p>
        <p className="text-micro text-quiet-ink">
          {isPaid
            ? "Payment confirmed for this wallet."
            : receipt.status === "payout_pending"
              ? "Your reward is secured for this wallet. Sending follows automatically."
              : "Your reward is secured for this wallet."}
        </p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className={`space-y-3 ${className}`}>
        <p className="text-body text-quiet-ink">{errorCopy(errorCode)}</p>
        <Button variant="secondary" size="md" onClick={() => void reset()}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase === "idle" || phase === "requesting_challenge" || phase === "awaiting_signature" || phase === "submitting_claim") {
    const busy = phase !== "idle";
    return (
      <div className={className}>
        <Button
          variant="primary"
          size="md"
          disabled={busy || !sessionReady}
          onClick={() => void start()}
        >
          {busy ? PHASE_LABEL[phase] : "Claim NIM"}
        </Button>
        {!sessionReady && phase === "idle" ? (
          <p className="mt-2 text-micro text-quiet-ink">
            Connect and verify your wallet to claim.
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}
