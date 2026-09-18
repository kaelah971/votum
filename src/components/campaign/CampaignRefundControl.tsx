"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { refundCampaign } from "@/lib/campaigns/creator-client";

interface CampaignRefundControlProps {
  campaignId: string;
  /**
   * Server campaign status. The refund action is offered only for closed
   * giveaways; every other lifecycle renders nothing. Whether a remainder
   * is actually refundable is decided server-side on each attempt.
   */
  campaignStatus: string | null;
}

type RefundStage = "idle" | "preparing" | "processed" | "refunded";

/**
 * Creator refund control for a Participation Campaign (Public Giveaway).
 *
 * Thin trigger over the server-controlled refund flow: the server derives
 * the amount, recipient, and intent, then signs and broadcasts from the
 * campaign vault. The browser never calculates amounts and never touches
 * transport — retrying after a blocked state is a safe idempotent POST,
 * never a resend.
 */
export function CampaignRefundControl({
  campaignId,
  campaignStatus,
}: CampaignRefundControlProps) {
  const [stage, setStage] = useState<RefundStage>("idle");
  const [processedStatus, setProcessedStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  if (campaignStatus !== "closed") {
    return null;
  }

  if (stage === "refunded") {
    return (
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Refund remaining NIM
          </h2>
          <Badge variant="verified">Refunded</Badge>
        </div>
        <p className="text-body text-quiet-ink" role="status">
          Refunded — nothing remaining. Participant rewards that were earned
          stay protected.
        </p>
      </Card>
    );
  }

  async function handleRefund() {
    setError(null);
    setBlocked(false);
    setStage("preparing");
    try {
      const result = await refundCampaign(campaignId);
      if (result.kind === "error") {
        if (
          result.error.code === "unresolved_reward_obligations" ||
          result.error.code === "payout_reconciliation_required"
        ) {
          // Ordinary blocked state: obligations still settling. Retrying
          // later is a safe idempotent POST, never a transport resend.
          setBlocked(true);
        }
        setError(
          `Could not prepare the refund (${result.error.code}).${result.error.message ? ` ${result.error.message}` : " Try again once payouts have settled."}`,
        );
        setStage("idle");
        return;
      }
      if (result.kind === "refunded") {
        setStage("refunded");
        return;
      }
      setProcessedStatus(result.status);
      setStage("processed");
    } catch {
      setError("Votum could not reach the campaign service. Try again.");
      setStage("idle");
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div>
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY REFUND
        </p>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Refund remaining NIM
          </h2>
          {stage === "processed" && (
            <Badge variant="amber">Processing</Badge>
          )}
        </div>
        <ul className="mt-2 text-secondary text-quiet-ink list-disc pl-5 space-y-1">
          <li>
            The unused remainder becomes refundable only after participant
            obligations settle.
          </li>
          <li>Already-earned participant rewards are protected.</li>
          <li>If payouts are still unresolved, the refund stays blocked.</li>
          <li>Refund execution is server-controlled, end to end.</li>
        </ul>
      </div>

      {stage === "processed" ? (
        <p className="text-body text-fairness-amber" role="status" aria-live="polite">
          Refund submitted{processedStatus ? ` (${processedStatus})` : ""} — Votum
          is settling the remainder. No further action is needed.
        </p>
      ) : (
        <Button
          type="button"
          className="w-full"
          disabled={stage !== "idle"}
          onClick={handleRefund}
        >
          {stage === "preparing" ? "Preparing refund…" : "Refund remaining NIM"}
        </Button>
      )}
      {error && (
        <p className="text-micro text-reject-red" role="alert">
          {error}
        </p>
      )}
      {blocked && stage === "idle" && (
        <p className="text-body text-fairness-amber" role="status">
          Refund blocked — participant payouts are still being settled. Earned
          rewards stay protected; try again once payouts complete.
        </p>
      )}
    </Card>
  );
}
