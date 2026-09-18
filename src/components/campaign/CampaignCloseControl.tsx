"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { closeCampaign } from "@/lib/campaigns/creator-client";

interface CampaignCloseControlProps {
  campaignId: string;
  /**
   * Server campaign status. The control is offered for closeable
   * lifecycles (`draft`, `published`); `closed` renders a Closed state;
   * terminal non-close states render nothing. The server remains the final
   * authority (`invalid_state` is shown inline).
   */
  campaignStatus: string | null;
  onClosed?: (settlementId: string) => void;
}

const CLOSEABLE = new Set(["draft", "published"]);

/**
 * Creator close control for a Participation Campaign (Public Giveaway).
 *
 * Closing stops new claims immediately while already reserved participant
 * rewards stay protected. Close is replay-safe. Refund is a separate,
 * later-owned surface — this control never calculates or offers it.
 */
export function CampaignCloseControl({
  campaignId,
  campaignStatus,
  onClosed,
}: CampaignCloseControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (campaignStatus === "closed" || closed) {
    return (
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Close giveaway
          </h2>
          <Badge variant="default">Closed</Badge>
        </div>
        <p className="text-body text-quiet-ink" role="status">
          This giveaway is closed. New claims are stopped; already reserved
          participant rewards remain protected.
        </p>
      </Card>
    );
  }

  if (campaignStatus === null || !CLOSEABLE.has(campaignStatus)) {
    return null;
  }

  async function handleConfirmClose() {
    setError(null);
    setClosing(true);
    try {
      const result = await closeCampaign(campaignId);
      if (result.kind === "error") {
        setError(
          `Could not close (${result.error.code}).${result.error.message ? ` ${result.error.message}` : " Try again."}`,
        );
        setClosing(false);
        return;
      }
      setConfirming(false);
      setClosed(true);
      onClosed?.(result.settlementId);
    } catch {
      setError("Votum could not reach the campaign service. Try again.");
      setClosing(false);
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div>
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY CLOSURE
        </p>
        <h2 className="mt-2 font-display text-section-heading text-ballot-ink">
          Close giveaway
        </h2>
        <p className="mt-2 text-body text-quiet-ink">
          Closing stops new claims. Reserved rewards stay protected.
        </p>
      </div>

      {!confirming ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Close giveaway
        </Button>
      ) : (
        <div
          className="rounded-overlay border border-reject-red/30 bg-reject-red/[0.04] p-4 space-y-3"
          role="group"
          aria-label="Confirm closing this giveaway"
        >
          <p className="text-body text-ballot-ink font-medium">
            Close this giveaway now?
          </p>
          <ul className="text-secondary text-quiet-ink list-disc pl-5 space-y-1">
            <li>Closing stops new claims immediately.</li>
            <li>Already reserved participant rewards remain protected.</li>
            <li>Existing payouts may continue.</li>
            <li>
              The unused remainder can be refunded only after obligations
              settle.
            </li>
          </ul>
          {error && (
            <p className="text-micro text-reject-red" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              disabled={closing}
              onClick={() => {
                setError(null);
                setConfirming(false);
              }}
            >
              Keep open
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={closing}
              onClick={handleConfirmClose}
            >
              {closing ? "Closing…" : "Confirm close"}
            </Button>
          </div>
        </div>
      )}
      {error && !confirming && (
        <p className="text-micro text-reject-red" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
