import type { PublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";
import { FairnessLabel } from "@/components/ui/FairnessLabel";

function StatusIcon({ state }: { state: string }) {
  if (state === "open") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0">
        <path
          d="M13.5 4.5L6 12L2.5 8.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7 6.5V10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="7" cy="4.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stateCopy(giveaway: PublicCampaignGiveaway): { title: string; detail: string } {
  switch (giveaway.claimState) {
    case "open":
      return {
        title: "Open now",
        detail: `${giveaway.remainingRewards} of ${giveaway.maxRewardedParticipants} rewards remaining.`,
      };
    case "needs_funding":
      return {
        title: "Funding pending",
        detail: "Rewards unlock once the creator funds this campaign.",
      };
    case "starts_soon":
      return {
        title: `Starts at ${giveaway.startsAt ? formatDate(giveaway.startsAt) : "the announced time"}`,
        detail: "Claiming is not open yet.",
      };
    case "full":
      return {
        title: "Sold out",
        detail: "All rewards are reserved.",
      };
    case "ended":
      return {
        title: "Ended",
        detail: "This campaign has ended.",
      };
    case "closed":
      return {
        title: "Closed",
        detail: "This campaign is closed.",
      };
    default:
      return {
        title: "Not available",
        detail: "This campaign cannot be shown right now.",
      };
  }
}

interface CampaignGiveawayViewProps {
  giveaway: PublicCampaignGiveaway;
  className?: string;
}

/**
 * Presentational share-link surface for a Public Giveaway. Renders only the
 * public DTO: no wallets, no challenges, no receipts, no vault data, and no
 * own-claim state. In the open state it reserves the single-CTA slot with a
 * disabled, non-actionable Claim NIM placeholder until the participant
 * slice lands; it never implies claiming is possible today.
 */
export function CampaignGiveawayView({ giveaway, className = "" }: CampaignGiveawayViewProps) {
  const state = stateCopy(giveaway);
  const isOpen = giveaway.claimState === "open";

  return (
    <article className={`rounded-card border border-divider bg-clear-ballot p-6 shadow-card ${className}`}>
      <p className="text-micro font-medium uppercase text-micro-grey">
        Verified community reward
      </p>
      <h1 className="mt-2 font-display text-card-heading font-medium text-ballot-ink">
        {giveaway.title}
      </h1>
      {giveaway.description ? (
        <p className="mt-2 text-body text-quiet-ink">{giveaway.description}</p>
      ) : null}

      <dl className="mt-5 space-y-2 border-t border-divider pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-micro text-quiet-ink">Reward per participant</dt>
          <dd className="font-proof text-proof text-nim-blue">{giveaway.rewardPerParticipantNim}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-micro text-quiet-ink">Rewards remaining</dt>
          <dd className="font-proof text-proof text-ballot-ink">
            {giveaway.remainingRewards} of {giveaway.maxRewardedParticipants}
          </dd>
        </div>
        {giveaway.startsAt ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-micro text-quiet-ink">Starts</dt>
            <dd className="font-proof text-proof text-ballot-ink">{formatDate(giveaway.startsAt)}</dd>
          </div>
        ) : null}
        {giveaway.endsAt ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-micro text-quiet-ink">Ends</dt>
            <dd className="font-proof text-proof text-ballot-ink">{formatDate(giveaway.endsAt)}</dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-micro text-quiet-ink">Reserved · Paid</dt>
          <dd className="font-proof text-proof text-quiet-ink">
            {giveaway.reservedCount} reserved · {giveaway.paidCount} paid
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex items-center gap-2 text-body text-quiet-ink">
        <StatusIcon state={giveaway.claimState} />
        <p>
          <span data-testid="campaign-state-title" className="font-medium text-ballot-ink">{state.title}</span>
          {` — ${state.detail}`}
        </p>
      </div>

      <div className="mt-5">
        <FairnessLabel rule="One wallet · one claim" />
      </div>

      {isOpen ? (
        <div className="mt-5">
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="inline-flex w-full items-center justify-center rounded-full bg-signal-gold px-6 py-4 text-sm font-medium text-ballot-ink disabled:pointer-events-none disabled:opacity-50"
          >
            Claim NIM
          </button>
          <p className="mt-2 text-center text-micro text-quiet-ink">
            Claiming is not available yet.
          </p>
        </div>
      ) : null}
    </article>
  );
}
