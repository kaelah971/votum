"use client";

import { useCallback, useState } from "react";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { ClaimNimButton } from "@/components/campaign/ClaimNimButton";
import { CampaignClaimStatus } from "@/components/campaign/CampaignClaimStatus";
import { WalletButton } from "@/components/ui/WalletButton";
import type { PublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";

interface CampaignClaimSectionProps {
  campaignId: string;
  claimState: PublicCampaignGiveaway["claimState"];
  /** Server-derived: viewer owns this campaign. Never a client decision. */
  viewerIsCreator: boolean;
  className?: string;
}

/**
 * Session-aware claim composition for the public share page. The status
 * panel is server-authoritative: once it reports a claim, the Claim NIM
 * affordance disappears. A successful claim bumps an immediate status
 * refresh. Non-open lifecycle states render no CTA; creators get an
 * informational state with no management controls.
 */
export function CampaignClaimSection({ campaignId, claimState, viewerIsCreator, className = "" }: CampaignClaimSectionProps) {
  const { status: sessionStatus, isSessionVerified, isWalletMatched, verifyActiveWallet } = useVotumSession();
  const [claimedKnown, setClaimedKnown] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const handleClaimedChange = useCallback((claimed: boolean) => {
    if (claimed) setClaimedKnown(true);
  }, []);

  const handleClaimed = useCallback(() => {
    setClaimedKnown(true);
    setRefreshSignal((signal) => signal + 1);
  }, []);

  const sessionReady = isSessionVerified && isWalletMatched;
  const isOpen = claimState === "open";
  const showCta = isOpen && !viewerIsCreator && sessionReady && !claimedKnown;
  const showStatus = !viewerIsCreator && (sessionReady || claimedKnown);

  return (
    <div className={`space-y-4 ${className}`}>
      {viewerIsCreator ? (
        <div className="rounded-thumbnail border border-divider bg-soft-fog px-4 py-3">
          <p className="text-body font-medium text-ballot-ink">Your campaign</p>
          <p className="mt-1 text-micro text-quiet-ink">
            Claims from your creator wallet are not eligible. Share the link so others can participate.
          </p>
        </div>
      ) : null}

      {!viewerIsCreator && isOpen && !sessionReady ? (
        <div className="space-y-3">
          <WalletButton />
          {sessionStatus === "verified_wallet_mismatch" ? (
            <p className="text-body text-quiet-ink">
              Wallet mismatch — the active wallet must match the verified session to claim.
            </p>
          ) : sessionStatus === "verified_no_wallet" ? (
            <div className="space-y-2">
              <p className="text-body text-quiet-ink">
                Connect the verified wallet to continue.
              </p>
              <button
                type="button"
                onClick={() => void verifyActiveWallet()}
                className="text-micro text-quiet-ink underline underline-offset-2 hover:text-ballot-ink transition-colors cursor-pointer min-h-[44px] inline-flex items-center"
              >
                Verify this wallet
              </button>
            </div>
          ) : (
            <p className="text-body text-quiet-ink">
              Connect and verify your wallet to claim.
            </p>
          )}
        </div>
      ) : null}

      {showCta ? (
        <ClaimNimButton campaignId={campaignId} onClaimed={handleClaimed} />
      ) : null}

      {showStatus ? (
        <CampaignClaimStatus
          campaignId={campaignId}
          refreshSignal={refreshSignal}
          onClaimedChange={handleClaimedChange}
        />
      ) : null}
    </div>
  );
}
