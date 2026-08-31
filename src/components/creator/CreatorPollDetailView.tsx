import type { CreatorPollDetail, PollStatus } from "@/types/poll";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Divider } from "@/components/ui/Divider";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { CopyIcon } from "@/components/ui/icons";
import { truncateAddress, formatClosingTime } from "@/lib/format";
import { formatNimAmount } from "@/lib/nimiq/units";
import Link from "next/link";

interface CreatorPollDetailViewProps {
  poll: CreatorPollDetail;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const statusBadgeVariant: Record<PollStatus, "signal" | "default" | "verified" | "reject"> =
  {
    live: "signal",
    draft: "default",
    closed: "default",
    cancelled: "reject",
  };

const statusLabel: Record<PollStatus, string> = {
  live: "Live",
  draft: "Draft",
  closed: "Closed",
  cancelled: "Cancelled",
};

const modeLabel: Record<string, string> = {
  creator: "Creator-funded",
  community: "Community-funded",
};

function formatRewardNim(luna: string): string {
  try {
    return formatNimAmount(BigInt(luna));
  } catch {
    return "Unavailable";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreatorPollDetailView({
  poll,
  className = "",
}: CreatorPollDetailViewProps) {
  const isLegacySupport = poll.economicModel === "legacy_support";

  return (
    <div className={`space-y-8 ${className}`}>
      {/* ================================================================= */}
      {/* 1. HEADER                                                          */}
      {/* ================================================================= */}
      <section className="space-y-3">
        <h1 className="text-section-heading font-display text-ballot-ink">
          {poll.question}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={statusBadgeVariant[poll.status]}>
            {statusLabel[poll.status]}
          </Badge>
          <span className="text-micro text-quiet-ink">
            Created {formatClosingTime(new Date(poll.createdAt))}
          </span>
          <span className="text-micro text-fairness-amber">
            Closes {formatClosingTime(new Date(poll.closingAt))}
          </span>
        </div>
      </section>

      <Divider />

      {/* ================================================================= */}
      {/* 2. POLL SUMMARY                                                    */}
      {/* ================================================================= */}
      <section>
        <h2 className="text-card-heading font-display text-ballot-ink mb-4">
          Poll summary
        </h2>
        <Card className="p-5 space-y-4">
          {isLegacySupport ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-secondary text-quiet-ink">
                  Contribution mode
                </span>
                <Badge variant="default">
                  {modeLabel[poll.contributionMode] ?? poll.contributionMode}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-secondary text-quiet-ink">Purpose</span>
                <span className="text-body text-ballot-ink text-right max-w-[60%]">
                  {poll.destinationPurpose}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-secondary text-quiet-ink">
                  Destination wallet
                </span>
                <span className="text-proof text-nim-blue">
                  {truncateAddress(poll.destinationWallet)}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-secondary text-quiet-ink">
                  Minimum contribution
                </span>
                <span className="text-proof text-nim-blue">
                  {poll.minimumNim.toLocaleString()} NIM
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-secondary text-quiet-ink">
                  Participation model
                </span>
                <Badge variant="default">
                  {poll.rewardMode === "rewarded"
                    ? "Rewarded participation"
                    : "Free verified poll"}
                </Badge>
              </div>
              {poll.rewardCampaign && (
                <div className="flex items-center justify-between">
                  <span className="text-secondary text-quiet-ink">
                    Reward status
                  </span>
                  <span className="text-body text-quiet-ink">
                    {poll.rewardCampaign.status}
                    {poll.rewardCampaign.funded
                      ? ` · ${formatRewardNim(poll.rewardCampaign.rewardPerParticipantLuna)} per participant`
                      : " · funding required"}
                  </span>
                </div>
              )}
            </>
          )}

          {/* Fairness rule */}
          <div className="flex items-center justify-between">
            <span className="text-secondary text-quiet-ink">
              Fairness rule
            </span>
            <FairnessLabel rule={poll.fairnessMode} />
          </div>
        </Card>
      </section>

      {/* ================================================================= */}
      {/* 3. RESULT OVERVIEW (conditional)                                   */}
      {/* ================================================================= */}
      {poll.results && (
        <>
          <Divider />
          <section>
            <h2 className="text-card-heading font-display text-ballot-ink mb-4">
              Result overview
            </h2>
            <Card className="p-5 space-y-4">
              {/* Totals */}
              <div className="flex flex-wrap gap-6">
                {poll.results.totalWallets !== undefined && (
                  <div>
                    <span className="block text-proof text-nim-blue">
                      {poll.results.totalWallets.toLocaleString()}
                    </span>
                    <span className="block text-micro text-quiet-ink">
                      total wallet
                      {poll.results.totalWallets !== 1 ? "s" : ""}
                    </span>
                  </div>
                )}
                {isLegacySupport && poll.results.totalNim !== undefined && (
                  <div>
                    <span className="block text-proof text-nim-blue">
                      {poll.results.totalNim.toLocaleString()}
                    </span>
                    <span className="block text-micro text-quiet-ink">
                       total legacy NIM support
                    </span>
                  </div>
                )}
              </div>

              <Divider className="my-3" />

              {/* Option-by-option breakdown */}
              <div className="space-y-3">
                {poll.results.options.map((option) => (
                  <div
                    key={option.id}
                    className="flex items-center justify-between"
                  >
                    <span className="text-body text-ballot-ink">
                      {option.label}
                      {option.isLeading && (
                        <span className="ml-1.5 text-micro text-signal-gold">
                          leading
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-4 text-right">
                      {/* Wallet count */}
                      {option.walletCount !== undefined && (
                        <span className="text-proof text-nim-blue">
                          {option.walletCount.toLocaleString()} wallet
                          {option.walletCount !== 1 ? "s" : ""}
                        </span>
                      )}
                {/* Legacy support is separate from verified participation. */}
                {isLegacySupport && option.nimSignalled !== undefined && (
                  <span className="text-proof text-nim-blue">
                    {option.nimSignalled.toLocaleString()} NIM support
                  </span>
                )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        </>
      )}

      <Divider />

      {/* ================================================================= */}
      {/* 4. CREATOR ACTIONS                                                 */}
      {/* ================================================================= */}
      <section>
        <h2 className="text-card-heading font-display text-ballot-ink mb-4">
          Creator actions
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {poll.publicUrl ? (
            <Link
              href={poll.publicUrl}
              className="inline-flex items-center justify-center rounded-full bg-soft-fog text-ballot-ink border border-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold"
            >
              View public poll
            </Link>
          ) : null}

          <Button variant="secondary" disabled>
            Close poll
          </Button>
        </div>
        <p className="text-micro text-quiet-ink mt-2">
          Creator controls will be enabled during product integration.
        </p>
      </section>

      {/* ================================================================= */}
      {/* 5. SHARE PANEL (conditional)                                       */}
      {/* ================================================================= */}
      {poll.publicUrl && (
        <>
          <Divider />
          <section>
            <h2 className="text-card-heading font-display text-ballot-ink mb-4">
              Share
            </h2>
            <Card className="p-5 space-y-3">
              {/* Public URL */}
              <p className="text-proof text-nim-blue break-all">
                {poll.publicUrl}
              </p>

              {/* Disabled copy button */}
              <div className="flex items-center">
                <Button variant="secondary" size="sm" disabled>
                  <CopyIcon className="mr-1.5" />
                  Copy link
                </Button>
              </div>

              {/* QR note */}
              <p className="text-micro text-quiet-ink">
                QR code will be available after publishing.
              </p>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
