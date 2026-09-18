"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { publishCampaign } from "@/lib/campaigns/creator-client";

interface CampaignPublishControlProps {
  campaignId: string;
  /**
   * Server campaign status from funding readiness (`draft`, `published`,
   * `closed`, `expired`, `cancelled`). `null` while readiness is loading.
   * Publication is allowed only for drafts — the control derives nothing
   * beyond this server state.
   */
  campaignStatus: string | null;
  onPublished?: (campaign: unknown) => void;
}

type PublishStage = "idle" | "publishing" | "published";

/**
 * Creator publish control for a Participation Campaign (Public Giveaway).
 *
 * Enabled only while the server reports a draft; every other status disables
 * the action with a concise reason. Publishing freezes the configuration —
 * funding can still complete afterwards. No navigation; C4 owns composition.
 */
export function CampaignPublishControl({
  campaignId,
  campaignStatus,
  onPublished,
}: CampaignPublishControlProps) {
  const [stage, setStage] = useState<PublishStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const isDraft = campaignStatus === "draft";
  const justPublished = stage === "published";
  const alreadyPublished = campaignStatus === "published";
  const published = justPublished || alreadyPublished;

  const reason = alreadyPublished
    ? "Already published."
    : campaignStatus === null
      ? "Loading campaign status…"
      : !isDraft
        ? "This giveaway can no longer be published."
        : null;

  async function handlePublish() {
    if (!isDraft || stage !== "idle") return;
    setError(null);
    setStage("publishing");
    try {
      const result = await publishCampaign(campaignId);
      if (result.kind === "error") {
        setError(
          `Could not publish (${result.error.code}).${result.error.message ? ` ${result.error.message}` : " Try again."}`,
        );
        setStage("idle");
        return;
      }
      setStage("published");
      onPublished?.(result.campaign);
    } catch {
      setError("Votum could not reach the campaign service. Try again.");
      setStage("idle");
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div>
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY PUBLICATION
        </p>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Publish giveaway
          </h2>
          {published && <Badge variant="nim">Published</Badge>}
        </div>
        <p className="mt-2 text-body text-quiet-ink">
          Publishing freezes the giveaway configuration. Participants can find
          it once published; rewards unlock once funding is verified.
        </p>
      </div>

      {justPublished && (
        <p className="text-body text-nim-blue" role="status" aria-live="polite">
          Giveaway published.
        </p>
      )}
      {reason && (
        <p className="text-body text-quiet-ink" role="status">
          {reason}
        </p>
      )}
      {error && (
        <p className="text-micro text-reject-red" role="alert">
          {error}
        </p>
      )}

      {!published && (
        <Button
          type="button"
          className="w-full"
          disabled={!isDraft || stage !== "idle"}
          onClick={handlePublish}
        >
          {stage === "publishing" ? "Publishing…" : "Publish giveaway"}
        </Button>
      )}
    </Card>
  );
}
