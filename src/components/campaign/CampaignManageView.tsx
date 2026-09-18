"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LoadingState } from "@/components/state/LoadingState";
import { CreateGate } from "@/components/creator/CreateGate";
import { CampaignFundingPanel } from "@/components/campaign/CampaignFundingPanel";
import { CampaignPublishControl } from "@/components/campaign/CampaignPublishControl";
import { CampaignCloseControl } from "@/components/campaign/CampaignCloseControl";
import { CampaignRefundControl } from "@/components/campaign/CampaignRefundControl";
import {
  getCampaignFundingReadiness,
  getPublicCampaign,
  type CampaignCreatorError,
} from "@/lib/campaigns/creator-client";
import { useVotumSession } from "@/providers/VotumSessionProvider";

// ---------------------------------------------------------------------------
// Browser-safe narrowing. Every value below comes from the Campaign APIs;
// fields that are absent are omitted, never guessed.
// ---------------------------------------------------------------------------

interface ManageCampaign {
  title: string;
  description: string | null;
  status: string;
  visibility: string | null;
  startsAt: string | null;
  endsAt: string | null;
  rewardPerParticipantNim: string | null;
}

interface ManageReadiness {
  ready: boolean;
  settlementStatus: string;
  fundedAmountLuna: string;
  requiredAmountLuna: string;
}

interface ManageAggregates {
  maxRewardedParticipants: number | null;
  remainingRewards: number | null;
  reservedCount: number | null;
  paidCount: number | null;
  claimState: string | null;
  rewardPerParticipantNim: string | null;
  startsAt: string | null;
  endsAt: string | null;
  visibility: string | null;
}

type AccessState =
  | "session_required"
  | "forbidden"
  | "not_found"
  | "server_error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function narrowCampaign(value: unknown): ManageCampaign | null {
  if (!isRecord(value) || typeof value.title !== "string") return null;
  const reward = isRecord(value.reward) ? value.reward : null;
  return {
    title: value.title,
    description: asString(value.description),
    status: typeof value.status === "string" ? value.status : "draft",
    visibility: asString(value.visibility),
    startsAt: asString(value.startsAt),
    endsAt: asString(value.endsAt),
    rewardPerParticipantNim: reward
      ? asString(reward.rewardPerParticipantNim)
      : null,
  };
}

function narrowReadiness(value: unknown): ManageReadiness | null {
  if (!isRecord(value) || typeof value.ready !== "boolean") return null;
  if (
    typeof value.settlementStatus !== "string" ||
    typeof value.fundedAmountLuna !== "string" ||
    typeof value.requiredAmountLuna !== "string"
  ) {
    return null;
  }
  return {
    ready: value.ready,
    settlementStatus: value.settlementStatus,
    fundedAmountLuna: value.fundedAmountLuna,
    requiredAmountLuna: value.requiredAmountLuna,
  };
}

function narrowAggregates(value: unknown): ManageAggregates | null {
  if (!isRecord(value)) return null;
  return {
    maxRewardedParticipants: asCount(value.maxRewardedParticipants),
    remainingRewards: asCount(value.remainingRewards),
    reservedCount: asCount(value.reservedCount),
    paidCount: asCount(value.paidCount),
    claimState: asString(value.claimState),
    rewardPerParticipantNim: asString(value.rewardPerParticipantNim),
    startsAt: asString(value.startsAt),
    endsAt: asString(value.endsAt),
    visibility: asString(value.visibility),
  };
}

function accessStateForError(error: CampaignCreatorError): AccessState {
  if (error.status === 401) return "session_required";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  return "server_error";
}

function formatWindow(value: string | null): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusBadge(status: string): { variant: "signal" | "nim" | "default"; label: string } {
  if (status === "draft") return { variant: "signal", label: "Draft" };
  if (status === "published") return { variant: "nim", label: "Published" };
  if (status === "closed") return { variant: "default", label: "Closed" };
  return { variant: "default", label: status };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function ManageView({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<ManageCampaign | null>(null);
  const [aggregates, setAggregates] = useState<ManageAggregates | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const result = await getCampaignFundingReadiness(campaignId);
    if (!mountedRef.current) return;
    if (result.kind === "error") {
      setAccessState(accessStateForError(result.error));
      setLoadError(
        result.error.status === 401 ||
          result.error.status === 403 ||
          result.error.status === 404
          ? null
          : (result.error.message ?? "Could not load this giveaway. Try again."),
      );
      return;
    }
    const nextCampaign = narrowCampaign(result.campaign);
    if (!nextCampaign) {
      setAccessState("server_error");
      setLoadError("Votum returned an unexpected response. Try again.");
      return;
    }
    const nextReadiness = narrowReadiness(result.fundingReadiness);
    if (!nextReadiness) {
      setAccessState("server_error");
      setLoadError("Votum returned an unexpected response. Try again.");
      return;
    }
    setAccessState(null);
    setLoadError(null);
    setCampaign(nextCampaign);
    // Public aggregates are best-effort: absence never blocks management.
    try {
      const pub = await getPublicCampaign(campaignId);
      if (!mountedRef.current) return;
      if (pub.kind !== "error") {
        setAggregates(narrowAggregates(pub.campaign));
      }
    } catch {
      // Aggregate failure stays silent; terms and controls still render.
    }
  }, [campaignId]);

  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  async function copyShareLink(path: string) {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (accessState) {
    const message =
      accessState === "session_required"
        ? "Your verified wallet session has expired. Verify your wallet again to manage this giveaway."
        : accessState === "forbidden"
          ? "Only the giveaway owner can manage this giveaway."
          : accessState === "not_found"
            ? "Giveaway not found."
            : "Could not load this giveaway. Try again.";
    return (
      <Card glass className="p-5 sm:p-7">
        <p className="text-body text-quiet-ink" role="status">
          {message}
        </p>
        {loadError && (
          <p className="text-micro text-reject-red mt-2" role="alert">
            {loadError}
          </p>
        )}
      </Card>
    );
  }

  if (!campaign) {
    return (
      <Card glass className="p-5 sm:p-7">
        <div aria-label="Loading giveaway">
          <LoadingState variant="list" count={3} />
        </div>
        <p className="text-body text-quiet-ink mt-3" role="status">
          Loading giveaway…
        </p>
      </Card>
    );
  }

  const status = statusOverride ?? campaign.status;
  const badge = statusBadge(status);
  const reward =
    campaign.rewardPerParticipantNim ??
    aggregates?.rewardPerParticipantNim ??
    null;
  const visibility = campaign.visibility ?? aggregates?.visibility ?? null;
  const startsAt = campaign.startsAt ?? aggregates?.startsAt ?? null;
  const endsAt = campaign.endsAt ?? aggregates?.endsAt ?? null;
  const startLabel = formatWindow(startsAt);
  const endLabel = formatWindow(endsAt);
  const windowLabel =
    startLabel && endLabel
      ? `${startLabel} – ${endLabel}`
      : (startLabel ?? endLabel ?? "Untimed");
  const sharePath = `/campaigns/${campaignId}`;

  return (
    <div className="flex flex-col gap-6">
      <Card glass className="p-5 sm:p-7">
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY MANAGEMENT
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-page-title text-ballot-ink">
            {campaign.title}
          </h1>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {campaign.description && (
          <p className="mt-2 text-body text-quiet-ink">
            {campaign.description}
          </p>
        )}
        {aggregates?.claimState && (
          <p className="text-micro text-quiet-ink mt-2">
            Participant view: {aggregates.claimState}
          </p>
        )}
      </Card>

      <Card glass className="p-5 sm:p-7">
        <h2 className="font-display text-section-heading text-ballot-ink">
          Giveaway terms
        </h2>
        <dl className="mt-4 space-y-2 text-secondary text-quiet-ink">
          {reward && (
            <div className="flex items-center justify-between gap-4">
              <dt>Reward per participant</dt>
              <dd className="font-medium text-ballot-ink">{reward} NIM</dd>
            </div>
          )}
          {aggregates?.maxRewardedParticipants !== null &&
            aggregates?.maxRewardedParticipants !== undefined && (
              <div className="flex items-center justify-between gap-4">
                <dt>Participant capacity</dt>
                <dd className="font-medium text-ballot-ink">
                  {aggregates.maxRewardedParticipants}
                </dd>
              </div>
            )}
          <div className="flex items-center justify-between gap-4">
            <dt>Campaign window</dt>
            <dd className="font-medium text-ballot-ink">{windowLabel}</dd>
          </div>
          {visibility && (
            <div className="flex items-center justify-between gap-4">
              <dt>Visibility</dt>
              <dd className="font-medium text-ballot-ink">{visibility}</dd>
            </div>
          )}
        </dl>
      </Card>

      {aggregates &&
        (aggregates.remainingRewards !== null ||
          aggregates.reservedCount !== null ||
          aggregates.paidCount !== null) && (
          <Card glass className="p-5 sm:p-7">
            <h2 className="font-display text-section-heading text-ballot-ink">
              Participation
            </h2>
            <dl className="mt-4 space-y-2 text-secondary text-quiet-ink">
              {aggregates.remainingRewards !== null && (
                <div className="flex items-center justify-between gap-4">
                  <dt>Remaining rewards</dt>
                  <dd className="font-medium text-ballot-ink">
                    {aggregates.remainingRewards}
                  </dd>
                </div>
              )}
              {aggregates.reservedCount !== null && (
                <div className="flex items-center justify-between gap-4">
                  <dt>Reserved</dt>
                  <dd className="font-medium text-ballot-ink">
                    {aggregates.reservedCount}
                  </dd>
                </div>
              )}
              {aggregates.paidCount !== null && (
                <div className="flex items-center justify-between gap-4">
                  <dt>Paid</dt>
                  <dd className="font-medium text-ballot-ink">
                    {aggregates.paidCount}
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        )}

      <Card glass className="p-5 sm:p-7">
        <h2 className="font-display text-section-heading text-ballot-ink">
          Share this giveaway
        </h2>
        <p className="mt-2 font-proof text-proof text-nim-blue break-all">
          {sharePath}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void copyShareLink(sharePath)}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          {copied && (
            <p className="text-micro text-verified-green" role="status">
              Link copied.
            </p>
          )}
        </div>
      </Card>

      <CampaignPublishControl
        campaignId={campaignId}
        campaignStatus={status}
        onPublished={(published) => {
          if (isRecord(published) && typeof published.status === "string") {
            setStatusOverride(published.status);
          } else {
            void load();
          }
        }}
      />

      {status === "draft" ? (
        <Card glass className="p-5 sm:p-7">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Fund this giveaway
          </h2>
          <p className="mt-2 text-body text-quiet-ink">
            Publish this giveaway first — funding opens once it is published.
          </p>
        </Card>
      ) : (
        <CampaignFundingPanel campaignId={campaignId} />
      )}

      <CampaignCloseControl
        campaignId={campaignId}
        campaignStatus={status}
        onClosed={() => setStatusOverride("closed")}
      />

      <CampaignRefundControl campaignId={campaignId} campaignStatus={status} />
    </div>
  );
}

/**
 * Creator management entry for a Participation Campaign. Verified, matched
 * sessions see the management surface; everyone else gets the shared create
 * onboarding gate. Ownership itself is enforced server-side (403).
 */
export function CampaignManageView({ campaignId }: { campaignId: string }) {
  const { isSessionVerified, isWalletMatched } = useVotumSession();

  if (!isSessionVerified || !isWalletMatched) {
    return <CreateGate />;
  }
  return <ManageView campaignId={campaignId} />;
}
