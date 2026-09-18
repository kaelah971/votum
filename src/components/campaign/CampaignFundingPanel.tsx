"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LoadingState } from "@/components/state/LoadingState";
import {
  normalizeWalletFailure,
  sendBasicTransactionWithData,
  type BasicTransactionWithData,
} from "@/lib/nimiq/client";
import { formatNimAmount } from "@/lib/nimiq/units";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import {
  bindCampaignFunding,
  confirmCampaignFunding,
  createCampaignFundingIntent,
  getCampaignFundingReadiness,
  type CampaignCreatorError,
} from "@/lib/campaigns/creator-client";
import {
  clearPendingRewardFunding,
  getPendingRewardFunding,
  setPendingRewardFunding,
} from "@/lib/rewards/pending-funding";
import { isBoundRewardFundingHash } from "@/lib/rewards/funding-state";

// ---------------------------------------------------------------------------
// Server-authoritative shapes (narrowed defensively; the Campaign APIs own
// every vault, amount, reference, and readiness value shown here).
// ---------------------------------------------------------------------------

interface CampaignFundingReadiness {
  ready: boolean;
  reason: "ready_for_funding" | "vault_not_ready" | "financially_frozen";
  settlementStatus: string;
  fundedAmountLuna: string;
  requiredAmountLuna: string;
  vaultReady: boolean;
}

interface CampaignReadModel {
  campaignId: string;
  title: string;
  status: string;
}

interface CampaignFundingIntent {
  fundingIntentId: string;
  campaignId: string;
  reference: string;
  memo: string;
  vaultAddressNq: string;
  requiredFundingLuna: string;
  requiredFundingNim: string;
  submittedTransactionHash: string | null;
  confirmationDeadline: string | null;
}

type AccessState =
  | "session_required"
  | "forbidden"
  | "not_found"
  | "server_error";

type FundingStage =
  | "loading"
  | "idle"
  | "creating_intent"
  | "awaiting_approval"
  | "binding"
  | "confirming"
  | "submitted"
  | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function narrowReadiness(value: unknown): CampaignFundingReadiness | null {
  if (!isRecord(value)) return null;
  if (typeof value.ready !== "boolean") return null;
  if (
    value.reason !== "ready_for_funding" &&
    value.reason !== "vault_not_ready" &&
    value.reason !== "financially_frozen"
  ) {
    return null;
  }
  if (
    typeof value.settlementStatus !== "string" ||
    typeof value.fundedAmountLuna !== "string" ||
    typeof value.requiredAmountLuna !== "string" ||
    typeof value.vaultReady !== "boolean"
  ) {
    return null;
  }
  return value as unknown as CampaignFundingReadiness;
}

function narrowCampaign(value: unknown): CampaignReadModel | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.campaignId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }
  return {
    campaignId: value.campaignId,
    title: value.title,
    status: value.status,
  };
}

function narrowIntent(value: unknown): CampaignFundingIntent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.fundingIntentId !== "string" ||
    typeof value.campaignId !== "string" ||
    typeof value.reference !== "string" ||
    typeof value.vaultAddressNq !== "string" ||
    typeof value.requiredFundingLuna !== "string"
  ) {
    return null;
  }
  return {
    fundingIntentId: value.fundingIntentId,
    campaignId: value.campaignId,
    reference: value.reference,
    memo: typeof value.memo === "string" ? value.memo : value.reference,
    vaultAddressNq: value.vaultAddressNq,
    requiredFundingLuna: value.requiredFundingLuna,
    requiredFundingNim:
      typeof value.requiredFundingNim === "string"
        ? value.requiredFundingNim
        : value.requiredFundingLuna,
    submittedTransactionHash: isBoundRewardFundingHash(
      value.submittedTransactionHash,
    )
      ? value.submittedTransactionHash
      : null,
    confirmationDeadline:
      typeof value.confirmationDeadline === "string"
        ? value.confirmationDeadline
        : null,
  };
}

function accessStateForError(error: CampaignCreatorError): AccessState {
  if (error.status === 401) return "session_required";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  return "server_error";
}

/** Display-only conversion of a server Luna string; never a funding input. */
function formatLuna(luna: string): string {
  try {
    return `${formatNimAmount(BigInt(luna))} NIM`;
  } catch {
    return `${luna} Luna`;
  }
}

function parseSafeLuna(value: string): number | null {
  try {
    const luna = BigInt(value);
    if (luna <= BigInt(0) || luna > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(luna);
  } catch {
    return null;
  }
}

function formatHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Creator funding panel for a Participation Campaign (Public Giveaway).
 *
 * Mirrors the proven Poll RewardFundingPanel state machine, reworded for
 * Campaigns: server readiness → funding intent → exact-amount wallet send →
 * bind hash → confirm/finality. The server is authoritative for the vault,
 * the exact amount, the reference, and readiness; the wallet send uses only
 * server-provided values. A broadcast hash is a callback, never proof.
 */
export function CampaignFundingPanel({ campaignId }: { campaignId: string }) {
  const { provider, isInsideNimiqPay, walletStatus } = useNimiqContext();
  const { isSessionVerified, isWalletMatched } = useVotumSession();
  const [campaign, setCampaign] = useState<CampaignReadModel | null>(null);
  const [readiness, setReadiness] = useState<CampaignFundingReadiness | null>(
    null,
  );
  const [intent, setIntent] = useState<CampaignFundingIntent | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [stage, setStage] = useState<FundingStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const mountedRef = useRef(true);

  const loadReadiness = useCallback(async () => {
    const result = await getCampaignFundingReadiness(campaignId);
    if (!mountedRef.current) return;
    if (result.kind === "error") {
      setAccessState(accessStateForError(result.error));
      setStage("idle");
      if (
        result.error.status !== 401 &&
        result.error.status !== 403 &&
        result.error.status !== 404
      ) {
        setError(
          result.error.message ??
            "Funding details are temporarily unavailable. Try again.",
        );
      }
      return;
    }
    const nextCampaign = narrowCampaign(result.campaign);
    const nextReadiness = narrowReadiness(result.fundingReadiness);
    if (!nextCampaign || !nextReadiness) {
      setAccessState("server_error");
      setError("Votum returned an unexpected funding response. Try again.");
      setStage("error");
      return;
    }
    setAccessState(null);
    setCampaign(nextCampaign);
    setReadiness(nextReadiness);
    if (nextReadiness.ready) {
      // Funded: never open another intent. Drop any stale resume record.
      clearPendingRewardFunding(campaignId);
      setTransactionHash(null);
      setStage("idle");
      return;
    }
    // Resume aid only: a recorded hash is rebound, never resent.
    const pending = getPendingRewardFunding(campaignId);
    if (isBoundRewardFundingHash(pending?.transactionHash)) {
      setTransactionHash(pending.transactionHash);
    }
    setStage("idle");
  }, [campaignId]);

  useEffect(() => {
    mountedRef.current = true;
    // Synchronize this client surface with the server read model.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReadiness();
    return () => {
      mountedRef.current = false;
    };
  }, [loadReadiness]);

  const confirmBoundIntent = useCallback(
    async (activeIntent: CampaignFundingIntent) => {
      setStage("confirming");
      try {
        const confirmed = await confirmCampaignFunding(
          campaignId,
          activeIntent.fundingIntentId,
        );
        if (!mountedRef.current) return false;
        if (confirmed.kind === "error") {
          // The hash stays recorded server-side; confirmation is retryable.
          setStage("submitted");
          setError(
            `Votum recorded the transaction but could not verify it yet (${confirmed.error.code}). It remains recorded — retry confirmation.`,
          );
          return false;
        }
        setError(null);
        clearPendingRewardFunding(campaignId);
        await loadReadiness();
        return true;
      } catch {
        if (!mountedRef.current) return false;
        setStage("submitted");
        setError(
          "Votum recorded the transaction but could not be reached for verification. Retry confirmation.",
        );
        return false;
      }
    },
    [campaignId, loadReadiness],
  );

  const bindTransaction = useCallback(
    async (activeIntent: CampaignFundingIntent, hash: string) => {
      setStage("binding");
      try {
        const bound = await bindCampaignFunding(
          campaignId,
          activeIntent.fundingIntentId,
          hash,
        );
        if (!mountedRef.current) return false;
        if (bound.kind === "error") {
          // The wallet already broadcast; only the server record is missing.
          setStage("submitted");
          setError(
            "Transaction sent, but Votum could not record it yet. Retry recording.",
          );
          return false;
        }
        setError(null);
        return confirmBoundIntent(activeIntent);
      } catch {
        if (!mountedRef.current) return false;
        setStage("submitted");
        setError(
          "Transaction sent, but Votum could not be reached. Retry recording.",
        );
        return false;
      }
    },
    [campaignId, confirmBoundIntent],
  );

  const handleFund = useCallback(async () => {
    setError(null);
    let activeIntent = intent;

    if (!activeIntent) {
      setStage("creating_intent");
      try {
        const created = await createCampaignFundingIntent(campaignId);
        if (!mountedRef.current) return;
        if (created.kind === "error") {
          setError(
            created.error.message ??
              "Could not prepare the funding request. Try again.",
          );
          setStage("error");
          return;
        }
        const nextIntent = narrowIntent(created.fundingIntent);
        if (!nextIntent) {
          setError(
            "Votum returned an unexpected funding request. No transaction was sent.",
          );
          setStage("error");
          return;
        }
        activeIntent = nextIntent;
        setIntent(activeIntent);
      } catch {
        if (!mountedRef.current) return;
        setError("Votum could not prepare the funding request. Try again.");
        setStage("error");
        return;
      }
    }

    if (!activeIntent) return;
    // A known hash (server replay or resumed record) is rebound — the wallet
    // is never asked to send twice for the same intent.
    const knownHash = isBoundRewardFundingHash(
      activeIntent.submittedTransactionHash,
    )
      ? activeIntent.submittedTransactionHash
      : transactionHash;
    if (knownHash) {
      setTransactionHash(knownHash);
      await bindTransaction(activeIntent, knownHash);
      return;
    }
    if (!provider) {
      setError("Nimiq Pay is not available.");
      setStage("error");
      return;
    }

    const value = parseSafeLuna(activeIntent.requiredFundingLuna);
    if (value === null) {
      setError(
        "The server returned an unsafe funding amount. No transaction was sent.",
      );
      setStage("error");
      return;
    }
    if (new TextEncoder().encode(activeIntent.memo).length > 64) {
      setError("The funding reference is too long. No transaction was sent.");
      setStage("error");
      return;
    }

    const transaction: BasicTransactionWithData = {
      recipient: activeIntent.vaultAddressNq,
      value,
      data: activeIntent.memo,
    };
    setStage("awaiting_approval");
    let result: Awaited<ReturnType<typeof sendBasicTransactionWithData>>;
    try {
      result = await sendBasicTransactionWithData(provider, transaction);
    } catch (sendError: unknown) {
      if (!mountedRef.current) return;
      const failure = normalizeWalletFailure(sendError);
      setError(
        "denied" in failure
          ? "Funding cancelled. No transaction was sent."
          : failure.error,
      );
      setStage("error");
      return;
    }
    if (!mountedRef.current) return;
    if ("denied" in result) {
      setError("Funding cancelled. No transaction was sent.");
      setStage("error");
      return;
    }
    if ("error" in result) {
      setError(result.error);
      setStage("error");
      return;
    }

    const hash = result.transactionHash;
    setTransactionHash(hash);
    setPendingRewardFunding({
      pollId: campaignId,
      campaignId: activeIntent.campaignId,
      fundingIntentId: activeIntent.fundingIntentId,
      transactionHash: hash,
      submittedAt: new Date().toISOString(),
    });
    await bindTransaction(activeIntent, hash);
  }, [bindTransaction, campaignId, intent, provider, transactionHash]);

  const handleRetryRecording = useCallback(async () => {
    if (!intent || !transactionHash) return;
    setError(null);
    await bindTransaction(intent, transactionHash);
  }, [bindTransaction, intent, transactionHash]);

  const handleRetryConfirmation = useCallback(async () => {
    if (!intent) return;
    setError(null);
    await confirmBoundIntent(intent);
  }, [confirmBoundIntent, intent]);

  const canFund = useMemo(() => {
    if (!provider || !isInsideNimiqPay) return false;
    if (
      walletStatus !== "connected" ||
      !isSessionVerified ||
      !isWalletMatched
    ) {
      return false;
    }
    if (!readiness || readiness.ready) return false;
    if (readiness.reason !== "ready_for_funding") return false;
    return stage === "idle" || stage === "error";
  }, [
    isInsideNimiqPay,
    isSessionVerified,
    isWalletMatched,
    provider,
    readiness,
    stage,
    walletStatus,
  ]);

  if (accessState) {
    const message =
      accessState === "session_required"
        ? "Your verified wallet session is required to fund this giveaway."
        : accessState === "forbidden"
          ? "Only the giveaway owner can fund this giveaway."
          : accessState === "not_found"
            ? "Giveaway not found."
            : "Funding details are temporarily unavailable. Try again.";
    return (
      <Card className="p-5">
        <p className="text-body text-quiet-ink" role="status" aria-live="polite">
          {message}
        </p>
        {error && (
          <p className="text-micro text-reject-red mt-2" role="alert">
            {error}
          </p>
        )}
      </Card>
    );
  }

  if (stage === "loading" || !readiness) {
    return (
      <Card className="p-5">
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY FUNDING
        </p>
        <div className="mt-3" aria-label="Loading funding details">
          <LoadingState variant="list" count={2} />
        </div>
        <p className="text-body text-quiet-ink mt-3" role="status">
          Loading funding details…
        </p>
      </Card>
    );
  }

  const isReady = readiness.ready;
  // Submitted only once a hash is bound server-side (or replayed by the
  // server). A merely resumed local record stays on the Continue path so the
  // wallet is never asked to send again but nothing is claimed prematurely.
  const replaySubmitted =
    intent !== null &&
    isBoundRewardFundingHash(intent.submittedTransactionHash);
  const isSubmitted =
    stage === "submitted" ||
    stage === "binding" ||
    stage === "confirming" ||
    replaySubmitted;
  const awaitingApproval = stage === "awaiting_approval";
  const showFundingAction =
    !isReady && readiness.reason === "ready_for_funding";
  const statusText = isReady
    ? "Giveaway funded"
    : stage === "creating_intent"
      ? "Preparing the server funding request…"
      : awaitingApproval
        ? "Approve the exact funding amount in Nimiq Pay."
        : stage === "binding"
          ? "Recording the transaction hash…"
          : stage === "confirming"
            ? "Verifying the transaction…"
            : isSubmitted
              ? "Funding submitted — waiting for network confirmation."
              : transactionHash
                ? "Funding in progress — continue without sending again."
                : null;

  return (
    <Card
      className="p-5 space-y-5"
      aria-busy={
        stage === "creating_intent" ||
        awaitingApproval ||
        stage === "binding" ||
        stage === "confirming"
      }
    >
      <div>
        <p className="text-micro text-quiet-ink tracking-wider">
          GIVEAWAY FUNDING
        </p>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="font-display text-section-heading text-ballot-ink">
            Fund this giveaway
          </h2>
          {isReady ? (
            <Badge variant="verified">Funded</Badge>
          ) : isSubmitted ? (
            <Badge variant="amber">Awaiting confirmation</Badge>
          ) : (
            <Badge variant="signal">Funding required</Badge>
          )}
        </div>
        {campaign && (
          <p className="mt-2 text-card-heading font-display text-ballot-ink">
            {campaign.title}
          </p>
        )}
        <p className="mt-2 text-body text-quiet-ink">
          The server locks the exact amount, vault, and reference before Nimiq
          Pay opens. Funding counts only once Votum verifies the transaction.
        </p>
      </div>

      <dl className="space-y-2 text-secondary text-quiet-ink">
        <div className="flex items-center justify-between gap-4">
          <dt>Required funding</dt>
          <dd className="font-medium text-ballot-ink">
            {formatLuna(readiness.requiredAmountLuna)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt>Funded so far</dt>
          <dd className="font-medium text-ballot-ink">
            {formatLuna(readiness.fundedAmountLuna)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-divider pt-2">
          <dt className="font-medium text-ballot-ink">Funding status</dt>
          <dd className="font-medium text-ballot-ink">
            {readiness.settlementStatus}
          </dd>
        </div>
      </dl>

      {intent && (
        <div className="rounded-thumbnail border border-divider bg-soft-fog/40 p-3 space-y-2">
          <div>
            <p className="text-micro text-quiet-ink">Campaign vault</p>
            <p className="mt-1 break-all font-proof text-micro text-ballot-ink">
              {intent.vaultAddressNq}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-micro text-quiet-ink">Reference</p>
            <p className="font-proof text-micro text-ballot-ink break-all">
              {intent.reference}
            </p>
          </div>
          {intent.confirmationDeadline && (
            <p className="text-micro text-quiet-ink">
              Confirm before {intent.confirmationDeadline}
            </p>
          )}
        </div>
      )}

      {!isReady && readiness.reason === "vault_not_ready" && (
        <p className="text-body text-fairness-amber" role="status">
          The campaign vault is not ready yet. Try again shortly — no action
          can be funded until the vault is provisioned.
        </p>
      )}
      {!isReady && readiness.reason === "financially_frozen" && (
        <p className="text-body text-quiet-ink" role="status">
          Funding is no longer available for this giveaway.
        </p>
      )}

      {statusText && (
        <p
          className={
            isReady
              ? "text-body text-verified-green"
              : "text-body text-fairness-amber"
          }
          role="status"
          aria-live="polite"
        >
          {statusText}
        </p>
      )}
      {isSubmitted && transactionHash && (
        <p
          className="text-micro text-nim-blue font-proof"
          aria-label="Submitted transaction hash"
        >
          {formatHash(transactionHash)}
        </p>
      )}
      {error && (
        <p className="text-micro text-reject-red" role="alert">
          {error}
        </p>
      )}

      {isReady ? (
        <p className="text-micro text-quiet-ink">
          This giveaway is funded. No further funding action is needed.
        </p>
      ) : isSubmitted ? (
        <div className="space-y-3">
          {transactionHash && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={stage === "binding" || stage === "confirming"}
              onClick={handleRetryRecording}
            >
              {stage === "binding" || stage === "confirming"
                ? "Recording transaction…"
                : "Retry recording transaction"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={stage === "binding" || stage === "confirming" || !intent}
            onClick={handleRetryConfirmation}
          >
            {stage === "confirming"
              ? "Verifying transaction…"
              : "Retry confirmation"}
          </Button>
          <p className="text-micro text-quiet-ink">
            Rewards are not available yet. Votum must verify the transaction
            first.
          </p>
        </div>
      ) : showFundingAction ? (
        <Button
          type="button"
          className="w-full"
          disabled={!canFund}
          onClick={handleFund}
        >
          {stage === "creating_intent"
            ? "Preparing funding…"
            : awaitingApproval
              ? "Waiting for Nimiq Pay…"
              : transactionHash || intent
                ? "Continue funding"
                : "Fund this giveaway"}
        </Button>
      ) : null}

      {showFundingAction && !isSubmitted && !isInsideNimiqPay && (
        <p className="text-micro text-quiet-ink text-center">
          Open Votum in Nimiq Pay to fund this giveaway.
        </p>
      )}
      {showFundingAction &&
        !isSubmitted &&
        isInsideNimiqPay &&
        walletStatus !== "connected" && (
          <p className="text-micro text-quiet-ink text-center">
            Connect your creator wallet to fund this giveaway.
          </p>
        )}
      {showFundingAction &&
        !isSubmitted &&
        isInsideNimiqPay &&
        walletStatus === "connected" &&
        !isSessionVerified && (
          <p className="text-micro text-quiet-ink text-center">
            Verify your creator wallet before funding.
          </p>
        )}
      {showFundingAction &&
        !isSubmitted &&
        isInsideNimiqPay &&
        isSessionVerified &&
        !isWalletMatched && (
          <p className="text-micro text-quiet-ink text-center">
            The connected wallet does not match the verified creator wallet.
          </p>
        )}
    </Card>
  );
}
