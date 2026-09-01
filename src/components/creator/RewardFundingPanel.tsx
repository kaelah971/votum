"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  normalizeWalletFailure,
  sendBasicTransactionWithData,
  type BasicTransactionWithData,
} from "@/lib/nimiq/client";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import {
  clearPendingRewardFunding,
  getPendingRewardFunding,
  setPendingRewardFunding,
} from "@/lib/rewards/pending-funding";
import {
  deriveRewardFundingDisplayState,
  isBoundRewardFundingHash,
} from "@/lib/rewards/funding-state";

interface FundingSummary {
  fundingIntentId: string;
  campaignId: string;
  reference: string;
  status: string;
  amountLuna: string;
  rewardPrincipalLuna: string | null;
  feeReserveLuna: string | null;
  submittedTransactionHash: string | null;
  confirmationDeadline: string | null;
  createdAt: string;
}

interface RewardConfig {
  pollQuestion: string | null;
  economicModel: "legacy_support" | "reward_first";
  rewardMode: "free" | "rewarded" | null;
  state: string;
  rewardPerParticipant: { luna: string; nim: number };
  maxRewardedParticipants: number;
  rewardPrincipal: { luna: string; nim: number };
  feeReserve: { luna: string; nim: number };
  totalRequiredFunding: { luna: string; nim: number };
  vaultAddressNq: string | null;
  funding: FundingSummary | null;
}

type AccessState = "session_required" | "forbidden" | "not_found" | "server_error";

interface FundingIntent {
  fundingIntentId: string;
  campaignId: string;
  reference: string;
  memo: string;
  vaultAddressNq: string;
  rewardPrincipalLuna: string;
  feeReserveLuna: string;
  requiredFundingLuna: string;
  requiredFundingNim: string;
  submittedTransactionHash: string | null;
  confirmationDeadline: string | null;
  createdAt: string;
}

type FundingStage =
  | "loading"
  | "idle"
  | "creating_intent"
  | "awaiting_approval"
  | "binding"
  | "submitted"
  | "error";

function formatHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function parseSafeLuna(value: string): number | null {
  try {
    const luna = BigInt(value);
    if (luna <= BigInt(0) || luna > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(luna);
  } catch {
    return null;
  }
}

export function RewardFundingPanel({ pollId }: { pollId: string }) {
  const { provider, isInsideNimiqPay, walletStatus } = useNimiqContext();
  const { isSessionVerified, isWalletMatched } = useVotumSession();
  const [config, setConfig] = useState<RewardConfig | null>(null);
  const [intent, setIntent] = useState<FundingIntent | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [stage, setStage] = useState<FundingStage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const mountedRef = useRef(true);

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch(`/api/polls/${pollId}/reward/config`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        if (mountedRef.current) {
          setAccessState(
            response.status === 401
              ? "session_required"
              : response.status === 403
                ? "forbidden"
                : "not_found",
          );
          setStage("idle");
        }
        return;
      }
      if (!response.ok) {
        throw new Error("Could not load reward funding details.");
      }
      const data = await response.json() as { config?: RewardConfig };
      if (!data.config) throw new Error("Invalid reward configuration response.");
      if (!mountedRef.current) return;

      setAccessState(null);
      setConfig(data.config);
      const serverFunding = data.config.funding;
      const pending = getPendingRewardFunding(pollId);
      const serverHash = isBoundRewardFundingHash(serverFunding?.submittedTransactionHash)
        ? serverFunding.submittedTransactionHash
        : null;
      const canResumePending = data.config.state === "configured" || data.config.state === "funding_pending";
      const pendingHash = canResumePending && isBoundRewardFundingHash(pending?.transactionHash)
        ? pending.transactionHash
        : null;
      const resumedHash = serverHash ?? pendingHash;
      setTransactionHash(resumedHash);
      if (serverFunding && data.config.vaultAddressNq) {
        setIntent({
          fundingIntentId: serverFunding.fundingIntentId,
          campaignId: serverFunding.campaignId,
          reference: serverFunding.reference,
          memo: serverFunding.reference,
          vaultAddressNq: data.config.vaultAddressNq,
          rewardPrincipalLuna: serverFunding.rewardPrincipalLuna ?? data.config.rewardPrincipal.luna,
          feeReserveLuna: serverFunding.feeReserveLuna ?? data.config.feeReserve.luna,
          requiredFundingLuna: serverFunding.amountLuna,
          requiredFundingNim: `${data.config.totalRequiredFunding.nim} NIM`,
          submittedTransactionHash: serverHash,
          confirmationDeadline: serverFunding.confirmationDeadline,
          createdAt: serverFunding.createdAt,
        });
      }
      const fundingDisplayState = deriveRewardFundingDisplayState(data.config.state, {
        status: serverFunding?.status ?? null,
        submittedTransactionHash: resumedHash,
      });
      if (fundingDisplayState === "submitted") {
        setStage("submitted");
      } else if (fundingDisplayState === "configured" || fundingDisplayState === "intent_pending") {
        // The intent exists but the creator has not produced a hash yet. It is
        // safe to retry the same server-authoritative intent.
        setStage("idle");
      } else {
        // Funded and terminal states remain visible as read-only campaign
        // status; they must never expose another funding action.
        setStage("idle");
        setError(null);
      }
    } catch (loadError) {
      if (mountedRef.current) {
        setStage("error");
        setAccessState("server_error");
        setError(loadError instanceof Error ? loadError.message : "Could not load reward funding details.");
      }
    }
  }, [pollId]);

  useEffect(() => {
    mountedRef.current = true;
    // Synchronize this client surface with the server read model.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadConfig();
    return () => {
      mountedRef.current = false;
    };
  }, [loadConfig]);

  const bindTransaction = useCallback(async (fundingIntent: FundingIntent, hash: string) => {
    setStage("binding");
    try {
      const response = await fetch(
        `/api/polls/${pollId}/reward/funding/intents/${fundingIntent.fundingIntentId}/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ transactionHash: hash }),
        },
      );
      const data = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) {
        setStage("submitted");
        setError(data.message ?? "Transaction sent, but Votum could not record it yet. Retry binding.");
        return false;
      }
      setError(null);
      setStage("submitted");
      clearPendingRewardFunding(pollId);
      await loadConfig();
      return true;
    } catch {
      setStage("submitted");
      setError("Transaction sent, but Votum could not be reached. Retry binding.");
      return false;
    }
  }, [loadConfig, pollId]);

  const handleFund = useCallback(async () => {
    setError(null);
    let activeIntent = intent;

    if (!activeIntent) {
      setStage("creating_intent");
      try {
        const response = await fetch(`/api/polls/${pollId}/reward/funding/intents`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await response.json().catch(() => ({})) as {
          fundingIntent?: FundingIntent;
          message?: string;
        };
        if (!response.ok || !data.fundingIntent) {
          setError(data.message ?? "Could not prepare the reward funding request.");
          setStage("error");
          return;
        }
        activeIntent = data.fundingIntent;
        setIntent(activeIntent);
      } catch {
        setError("Votum could not prepare the reward funding request. Try again.");
        setStage("error");
        return;
      }
    }

    if (!activeIntent) return;
    if (transactionHash) {
      await bindTransaction(activeIntent, transactionHash);
      return;
    }
    if (!provider) {
      setError("Nimiq Pay is not available.");
      setStage("error");
      return;
    }

    const value = parseSafeLuna(activeIntent.requiredFundingLuna);
    if (value === null) {
      setError("The server returned an unsafe funding amount. No transaction was sent.");
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
    } catch (fundingError: unknown) {
      const failure = normalizeWalletFailure(fundingError);
      setError("denied" in failure ? "Funding cancelled. No transaction was sent." : failure.error);
      setStage("error");
      return;
    }
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
      pollId,
      campaignId: activeIntent.campaignId,
      fundingIntentId: activeIntent.fundingIntentId,
      transactionHash: hash,
      submittedAt: new Date().toISOString(),
    });
    await bindTransaction(activeIntent, hash);
  }, [bindTransaction, intent, pollId, provider, transactionHash]);

  const handleRetryBinding = useCallback(async () => {
    if (!intent || !transactionHash) return;
    await bindTransaction(intent, transactionHash);
  }, [bindTransaction, intent, transactionHash]);

  const canFund = useMemo(() => {
    if (!provider || !isInsideNimiqPay) return false;
    if (walletStatus !== "connected" || !isSessionVerified || !isWalletMatched) return false;
    const fundingDisplayState = deriveRewardFundingDisplayState(config?.state ?? "", {
      status: intent ? "submitted" : null,
      submittedTransactionHash: transactionHash,
    });
    return (
      (fundingDisplayState === "configured" ||
        (fundingDisplayState === "intent_pending" && Boolean(intent))) &&
      (stage === "idle" || stage === "error")
    );
  }, [config?.state, intent, isInsideNimiqPay, isSessionVerified, isWalletMatched, provider, stage, transactionHash, walletStatus]);

  if (accessState) {
    const message =
      accessState === "session_required"
        ? "Your verified wallet session is required to manage this poll."
        : accessState === "forbidden"
          ? "You do not have permission to manage this poll."
          : accessState === "not_found"
            ? "Reward campaign not found for this poll."
            : "Reward funding details are temporarily unavailable. Try again.";

    return (
      <Card className="mt-6 p-5">
        <p className="text-body text-quiet-ink" role="status" aria-live="polite">{message}</p>
      </Card>
    );
  }

  if (!config) return null;

  const fundingDisplayState = deriveRewardFundingDisplayState(config.state, {
    status: intent ? "submitted" : null,
    submittedTransactionHash: transactionHash,
  });
  const isSubmitted = fundingDisplayState === "submitted";
  const isFunded = fundingDisplayState === "funded";
  const isIntentPending = fundingDisplayState === "intent_pending";
  const showFundingAction =
    fundingDisplayState === "configured" || (isIntentPending && Boolean(intent));
  const statusText = isFunded
    ? "Rewards funded"
    : stage === "awaiting_approval"
      ? "Approve the exact funding amount in Nimiq Pay."
      : stage === "creating_intent"
        ? "Preparing the server funding request…"
        : stage === "binding"
          ? "Recording the transaction hash…"
          : isSubmitted
            ? "Funding submitted — waiting for network confirmation."
            : isIntentPending
              ? "Funding not sent - retry funding."
              : null;

  return (
    <Card className="mt-6 p-5 space-y-5" aria-busy={stage === "loading" || stage === "creating_intent" || stage === "awaiting_approval" || stage === "binding"}>
      <div>
        <p className="text-micro text-quiet-ink tracking-wider">REWARD CAMPAIGN FUNDING</p>
        <h2 className="mt-2 font-display text-section-heading text-ballot-ink">Fund reward campaign</h2>
        {config.pollQuestion && (
          <h3 className="mt-4 text-card-heading font-display text-ballot-ink">
            {config.pollQuestion}
          </h3>
        )}
        {config.economicModel === "reward_first" && config.rewardMode === "rewarded" && (
          <p className="mt-2 text-secondary text-nim-blue">Rewarded participation</p>
        )}
        <p className="mt-2 text-body text-quiet-ink">
          The server locks these terms before Nimiq Pay opens. Funding remains
          pending until V2B.2.5 verifies the transaction on-chain.
        </p>
      </div>

      <dl className="space-y-2 text-secondary text-quiet-ink">
        <div className="flex items-center justify-between gap-4">
          <dt>Reward per participant</dt>
          <dd className="font-medium text-ballot-ink">{config.rewardPerParticipant.nim} NIM</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt>Maximum rewarded participants</dt>
          <dd className="font-medium text-ballot-ink">
            {config.maxRewardedParticipants.toLocaleString()}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt>Reward principal</dt>
          <dd className="font-medium text-ballot-ink">{config.rewardPrincipal.nim} NIM</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt>Fee reserve</dt>
          <dd className="font-medium text-ballot-ink">{config.feeReserve.nim} NIM</dd>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-divider pt-2">
          <dt className="font-medium text-ballot-ink">Total required funding</dt>
          <dd className="font-medium text-ballot-ink">{config.totalRequiredFunding.nim} NIM</dd>
        </div>
      </dl>

      <div className="rounded-thumbnail border border-divider bg-soft-fog/40 p-3">
        <p className="text-micro text-quiet-ink">Campaign vault</p>
        <p className="mt-1 break-all font-proof text-micro text-ballot-ink">
          {config.vaultAddressNq ?? "Vault address unavailable"}
        </p>
      </div>

      {statusText && (
        <p className="text-body text-fairness-amber" role="status" aria-live="polite">
          {statusText}
        </p>
      )}
      {isSubmitted && transactionHash && (
        <p className="text-micro text-nim-blue font-proof" aria-label="Submitted transaction hash">
          {formatHash(transactionHash)}
        </p>
      )}
      {error && (
        <p className="text-micro text-reject-red" role="alert">{error}</p>
      )}

      {isSubmitted ? (
        <div className="space-y-3">
          {transactionHash && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={stage === "binding"}
              onClick={handleRetryBinding}
            >
              {stage === "binding" ? "Recording transaction…" : "Retry recording transaction"}
            </Button>
          )}
          <p className="text-micro text-quiet-ink">
            Rewards are not available yet. Votum must verify the transaction on-chain first.
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
            : stage === "awaiting_approval"
              ? "Waiting for Nimiq Pay…"
              : intent || isIntentPending
                ? "Retry funding"
                : "Fund reward campaign"}
        </Button>
      ) : null}

      {showFundingAction && !isSubmitted && !isInsideNimiqPay && (
        <p className="text-micro text-quiet-ink text-center">Open Votum in Nimiq Pay to fund this campaign.</p>
      )}
      {showFundingAction && !isSubmitted && isInsideNimiqPay && walletStatus !== "connected" && (
        <p className="text-micro text-quiet-ink text-center">Connect your creator wallet to fund this campaign.</p>
      )}
      {showFundingAction && !isSubmitted && isInsideNimiqPay && walletStatus === "connected" && !isSessionVerified && (
        <p className="text-micro text-quiet-ink text-center">Verify your creator wallet before funding.</p>
      )}
      {showFundingAction && !isSubmitted && isInsideNimiqPay && isSessionVerified && !isWalletMatched && (
        <p className="text-micro text-quiet-ink text-center">The connected wallet does not match the verified creator wallet.</p>
      )}
    </Card>
  );
}
