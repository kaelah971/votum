"use client";

import type { ContributionMode } from "@/types/poll";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { CATEGORY_LABELS, FORMAT_LABELS } from "@/lib/polls/taxonomy";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Divider } from "@/components/ui/Divider";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { WalletButton } from "@/components/ui/WalletButton";
import { CheckIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Inline SVG icon
// ---------------------------------------------------------------------------

/** Info circle icon for the review step's unpublished notice. */
function InfoCircleIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 7.5V11"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="8" cy="5" r="0.6" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PollReviewProps {
  category: PollCategory;
  format: PollFormat;
  question: string;
  context: string;
  options: string[];
  contributionMode: ContributionMode | null;
  purpose: string;
  destinationWallet: string;
  minimumNim: string;
  duration: string;
  durationLabel: string;
  closingTime: string | null;
  onEditDecision: () => void;
  onEditSupport: () => void;
  /** The currently connected Nimiq wallet address, if any. */
  activeAccount?: string | null;
  /** Current wallet connection status from NimiqProvider. */
  walletStatus?: string;
  /** Current Votum session verification status. */
  sessionStatus?: string;
  /** Error message from the last verification attempt (if any). */
  sessionError?: string | null;
  /** Triggers the wallet ownership verification flow. */
  onVerifyActiveWallet?: () => Promise<void>;
  /** Whether the poll can currently be published (all conditions met). */
  canPublish?: boolean;
  /** Current publication lifecycle state. */
  publishState?: string;
  /** Error message from the last publish attempt, if any. */
  publishError?: string | null;
  /** Initiates the poll publication flow. */
  onPublish?: () => void;
}

export function PollReview({
  category,
  format,
  question,
  context,
  options,
  contributionMode: _contributionMode,
  purpose,
  destinationWallet,
  minimumNim,
  duration,
  durationLabel,
  closingTime,
  onEditDecision,
  onEditSupport,
  activeAccount,
  walletStatus,
  sessionStatus,
  sessionError,
  onVerifyActiveWallet,
  canPublish = false,
  publishState = "idle",
  publishError = null,
  onPublish,
}: PollReviewProps) {
  void _contributionMode;
  void duration;

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Poll preview label ---- */}
      <div>
        <p className="text-micro text-quiet-ink tracking-wider mb-2">
          POLL PREVIEW
        </p>
        <div className="rounded-card bg-soft-fog px-4 py-3 mb-6 flex items-start gap-2.5">
          <InfoCircleIcon className="w-4 h-4 text-quiet-ink flex-shrink-0 mt-px" />
          <p className="text-body text-quiet-ink">
            This poll has not been published.
          </p>
        </div>
      </div>

      {/* ---- Review Card ---- */}
      <Card className="p-6">
        <div className="flex flex-col gap-0">
          {/* ---- Section: Category ---- */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-micro text-quiet-ink tracking-wider uppercase">
                Category
              </h2>
              <button
                type="button"
                onClick={onEditDecision}
                className="text-sm text-signal-gold hover:text-deep-gold transition-colors font-medium focus-visible:outline-none focus-visible:underline"
              >
                Edit question and options
              </button>
            </div>
            <p className="text-body text-ballot-ink">
              {CATEGORY_LABELS[category]}
            </p>
          </section>

          <Divider />

          {/* ---- Section: Format ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Participation format
            </h2>
            <p className="text-body text-ballot-ink">
              {FORMAT_LABELS[format]}
            </p>
          </section>

          <Divider />

          {/* ---- Section: Question ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Question
            </h2>
            <p className="text-card-heading font-display text-ballot-ink">
              {question}
            </p>
            {context.trim() && (
              <p className="text-body text-quiet-ink mt-2">
                {context}
              </p>
            )}
          </section>

          <Divider />

          {/* ---- Section: What the NIM supports ---- */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-micro text-quiet-ink tracking-wider uppercase">
                What the NIM supports
              </h2>
              <button
                type="button"
                onClick={onEditSupport}
                className="text-sm text-signal-gold hover:text-deep-gold transition-colors font-medium focus-visible:outline-none focus-visible:underline"
              >
                Edit support details
              </button>
            </div>
            <p className="text-body text-ballot-ink">
              {purpose}
            </p>
          </section>

          <Divider />

          {/* ---- Section: Contribution destination ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Contribution destination
            </h2>
            <p className="font-proof text-proof text-nim-blue break-all">
              {destinationWallet}
            </p>
            {activeAccount &&
              destinationWallet.trim().toLowerCase() ===
                activeAccount.toLowerCase() && (
                <p className="text-micro text-nim-blue mt-1">
                  Connected wallet
                </p>
              )}
          </section>

          <Divider />

          {/* ---- Section: Minimum NIM contribution ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Minimum NIM contribution
            </h2>
            <p className="text-body text-ballot-ink">
              {minimumNim} NIM
            </p>
          </section>

          <Divider />

          {/* ---- Section: Poll options ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Poll options
            </h2>
            <ol className="list-decimal list-inside flex flex-col gap-1.5">
              {options.map((opt, i) => (
                <li key={i} className="text-body text-ballot-ink">
                  {opt.trim()}
                </li>
              ))}
            </ol>
          </section>

          <Divider />

          {/* ---- Section: Fairness rule ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Fairness rule
            </h2>
            <FairnessLabel />
          </section>

          <Divider />

          {/* ---- Section: Planned duration ---- */}
          <section>
            <h2 className="text-micro text-quiet-ink tracking-wider uppercase mb-2">
              Planned duration
            </h2>
            <p className="text-body text-ballot-ink">
              {durationLabel}
            </p>
            {closingTime && (
              <p className="text-secondary text-quiet-ink mt-1">
                Closes {closingTime}
              </p>
            )}
          </section>
        </div>
      </Card>

      {/* ---- Wallet verification status ---- */}
      <div className="flex flex-col items-center gap-3 pt-2">
        {walletStatus !== "connected" ? (
          <p className="text-micro text-quiet-ink text-center max-w-xs">
            Connect your Nimiq wallet to prepare this poll for publishing.
          </p>
        ) : sessionStatus === "verified_no_wallet" ? (
          <>
            <p className="text-body font-medium text-verified-green text-center flex items-center justify-center gap-1.5">
              <CheckIcon className="w-4 h-4" />
              Wallet ownership already verified.
            </p>
            <p className="text-micro text-quiet-ink text-center max-w-xs">
              Reconnect Nimiq Pay to continue. You will not need to sign again.
            </p>
            {/* Note: connectWallet is called from WalletButton, which is rendered elsewhere */}
          </>
        ) : sessionStatus === "verified_wallet_mismatch" ? (
          <>
            <p className="text-body font-medium text-fairness-amber text-center">
              The connected wallet does not match the verified session.
            </p>
            <Button type="button" variant="secondary" onClick={onVerifyActiveWallet}>
              Verify this wallet
            </Button>
          </>
        ) : sessionStatus === "unverified" ||
          sessionStatus === "permission_denied" ||
          sessionStatus === "error" ? (
          <>
            <Button
              type="button"
              variant="primary"
              onClick={onVerifyActiveWallet}
            >
              Verify wallet ownership
            </Button>
            {sessionStatus === "permission_denied" && (
              <p className="text-micro text-quiet-ink text-center max-w-xs">
                Wallet verification was not approved. No Votum session was
                created.
              </p>
            )}
            {sessionStatus === "error" && sessionError && (
              <p className="text-micro text-reject-red text-center max-w-xs">
                {sessionError}
              </p>
            )}
          </>
        ) : sessionStatus === "requesting_challenge" ||
          sessionStatus === "awaiting_signature" ? (
          <p className="text-body text-quiet-ink text-center">
            {sessionStatus === "awaiting_signature"
              ? "Confirm wallet verification in Nimiq Pay."
              : "Preparing wallet verification…"}
          </p>
        ) : sessionStatus === "verifying" ? (
          <p className="text-body text-quiet-ink text-center">
            Verifying wallet ownership…
          </p>
        ) : sessionStatus === "verified" ? (
          <p className="text-body font-medium text-verified-green flex items-center justify-center gap-1.5">
            <CheckIcon className="w-4 h-4" />
            Wallet ownership verified.
          </p>
        ) : (
          <p className="text-micro text-quiet-ink text-center max-w-xs">
            Connect your Nimiq wallet to get started.
          </p>
        )}
      </div>

      {/* ---- Publish area ---- */}
      <div className="flex flex-col items-center gap-3 pt-4">
        {onPublish && (
          <>
            {publishState === "success" ? (
              <div className="flex flex-col items-center gap-2">
                <p className="text-body font-medium text-verified-green flex items-center gap-1.5">
                  <CheckIcon className="w-4 h-4" />
                  Poll published
                </p>
                <p className="text-micro text-quiet-ink text-center">
                  Redirecting to your published poll…
                </p>
              </div>
            ) : (
              <>
                <Button
                  type="button"
                  variant="primary"
                  disabled={!canPublish}
                  onClick={onPublish}
                  className="w-full"
                >
                  {publishState === "preparing" ? "Preparing publication…" :
                   publishState === "publishing" ? "Publishing poll…" :
                   "Publish poll"}
                </Button>

                {publishError && (
                  <p className="text-micro text-reject-red text-center max-w-xs" role="alert">
                    {publishError}
                  </p>
                )}

                {publishState === "error" && (
                  <Button type="button" variant="secondary" size="sm" onClick={onPublish}>
                    Try again
                  </Button>
                )}

                {!canPublish && publishState === "idle" && sessionStatus !== "verified" && (
                  <p className="text-micro text-quiet-ink text-center max-w-xs">
                    Verify your wallet ownership to enable publishing.
                  </p>
                )}
                {!canPublish && publishState === "idle" && sessionStatus === "verified_no_wallet" && (
                  <p className="text-micro text-quiet-ink text-center max-w-xs">
                    Reconnect your Nimiq wallet to enable publishing.
                  </p>
                )}
              </>
            )}
          </>
        )}
        <WalletButton />
      </div>
    </div>
  );
}
