"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import {
  getPendingSupport,
  setPendingSupport,
  clearPendingSupport,
} from "@/lib/support/pending";
import { lunaToNim } from "@/lib/nimiq/units";

// ── Types ─────────────────────────────────────────────────────────────

interface SupportResults {
  totalNimLuna: string;
  options: Array<{
    optionId: string;
    label: string;
    nimLuna: string;
    contributionCount: number;
  }>;
}

interface SupportIntent {
  id: string;
  recipient: string;
  valueLuna: string;
  memo: string;
  expiresAt: string;
}

type SupportStage =
  | "idle"
  | "creating_intent"
  | "awaiting_approval"
  | "pending"
  | "confirmed"
  | "error";

interface PollNimSupportPanelProps {
  pollId: string;
  options: Array<{ id: string; label: string }>;
  isLive: boolean;
  /** Minimum NIM contribution — already in NIM (not Luna). */
  minimumNim: number;
  className?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Format a Luna string to a human-readable NIM display.
 * Accepts Luna as a decimal string (e.g. "100000" = 1 NIM).
 */
function formatLunaToNim(lunaStr: string): string {
  try {
    const luna = BigInt(lunaStr);
    const nim = lunaToNim(luna);
    const str = nim.toFixed(5).replace(/\.?0+$/, "");
    return `${str} NIM`;
  } catch {
    return "0 NIM";
  }
}

/**
 * Compact NIM display for inline result bars.
 */
function formatLunaToNimCompact(lunaStr: string): string {
  try {
    const luna = BigInt(lunaStr);
    const nim = lunaToNim(luna);
    if (Number.isInteger(nim)) return `${nim} NIM`;
    return `${nim.toFixed(5).replace(/\.?0+$/, "")} NIM`;
  } catch {
    return "0 NIM";
  }
}

// ── Inline SVG icon ────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="flex-shrink-0"
    >
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

// ── Component ──────────────────────────────────────────────────────────

export function PollNimSupportPanel({
  pollId,
  options,
  isLive,
  minimumNim,
  className = "",
}: PollNimSupportPanelProps) {
  const { provider, isInsideNimiqPay, walletStatus } = useNimiqContext();
  const { isSessionVerified, isWalletMatched } = useVotumSession();

  const [results, setResults] = useState<SupportResults | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string>("");
  // minimumNim is already in NIM (converted from Luna by the data layer),
  // so we use it directly without calling lunaToNim again.
  const [amountNim, setAmountNim] = useState<string>(
    minimumNim > 0 ? minimumNim.toString() : "",
  );
  const [stage, setStage] = useState<SupportStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<SupportIntent | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [confirmedContribution, setConfirmedContribution] = useState<{
    id: string;
  } | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Load public support results ────────────────────────────────────

  const loadResults = useCallback(async () => {
    try {
      const res = await fetch(`/api/polls/${pollId}/support/results`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.ok) setResults(await res.json());
    } catch {
      // Non-critical — results refresh on next trigger.
    }
  }, [pollId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadResults();
  }, [loadResults]);

  // ── Resume pending support on mount ────────────────────────────────

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const pending = getPendingSupport(pollId);
    if (pending && isSessionVerified) {
      setIntent({
        id: pending.intentId,
        recipient: "",
        valueLuna: "",
        memo: "",
        expiresAt: "",
      });
      setTxHash(pending.transactionHash);
      setSelectedOptionId(pending.optionId);
      setStage("pending");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [pollId, isSessionVerified]);

  // ── Confirm contribution (with exponential-backoff polling) ────────

  const confirmContribution = useCallback(
    async (intentId: string, transactionHash: string) => {
      const doConfirm = async () => {
        try {
          const res = await fetch(
            `/api/polls/${pollId}/support/confirm`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ intentId, transactionHash }),
            },
          );
          const data = await res.json();

          if (res.ok) {
            if (!mountedRef.current) return;
            setConfirmedContribution(data.contribution);
            clearPendingSupport(pollId);
            setStage("confirmed");
            loadResults();
            return;
          }

          if (res.status === 202) {
            if (!mountedRef.current) return;
            const delay = Math.min(
              Math.max(data.retryAfterMs ?? 5000, 3000),
              15000,
            );
            pollRef.current = setTimeout(doConfirm, delay);
            return;
          }

          // Terminal error
          if (!mountedRef.current) return;
          setError(
            data.message || "Could not confirm NIM support on-chain.",
          );
          setStage("error");
        } catch {
          if (!mountedRef.current) return;
          // Network hiccup — retry with back-off
          pollRef.current = setTimeout(doConfirm, 10000);
        }
      };
      doConfirm();
    },
    [pollId, loadResults],
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Resume confirmation from pending state
  useEffect(() => {
    if (stage === "pending" && intent?.id && txHash) {
      confirmContribution(intent.id, txHash);
    }
  }, [stage, intent, txHash, confirmContribution]);

  // ── Create intent & invoke Nimiq Pay ───────────────────────────────

  const handleCreateIntent = useCallback(async () => {
    if (!selectedOptionId || !amountNim) return;
    setStage("creating_intent");
    setError(null);

    try {
      const res = await fetch(`/api/polls/${pollId}/support/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          optionId: selectedOptionId,
          amountNim,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Could not create support intent.");
        setStage("error");
        return;
      }

      const it: SupportIntent = data.intent;
      if (!it?.id || !it?.recipient || !it?.valueLuna || !it?.memo) {
        setError("Invalid intent response from server.");
        setStage("error");
        return;
      }

      // Validate Luna amount is a safe positive integer
      const lunaBig = BigInt(it.valueLuna);
      if (
        lunaBig <= BigInt(0) ||
        lunaBig > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        setError("Support amount is out of range.");
        setStage("error");
        return;
      }
      const lunaNum = Number(lunaBig);
      if (!Number.isSafeInteger(lunaNum)) {
        setError("Support amount cannot be represented safely.");
        setStage("error");
        return;
      }

      // Memo must fit within 64 bytes (Nimiq extended-transaction limit)
      if (new TextEncoder().encode(it.memo).length > 64) {
        setError("Support memo is too long.");
        setStage("error");
        return;
      }

      setIntent(it);

      // Invoke Nimiq Pay to sign and broadcast the transaction
      if (!provider) {
        setError("Nimiq wallet not available.");
        setStage("error");
        return;
      }

      setStage("awaiting_approval");
      try {
        const raw = await provider.sendBasicTransactionWithData({
          recipient: it.recipient,
          value: lunaNum,
          data: it.memo,
        });

        // sendBasicTransactionWithData returns string | ErrorResponse
        if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
          setError("Invalid transaction hash returned by Nimiq Pay.");
          setStage("error");
          return;
        }

        const hash = raw;
        setTxHash(hash);
        setPendingSupport({
          pollId,
          intentId: it.id,
          transactionHash: hash,
          optionId: selectedOptionId,
          submittedAt: new Date().toISOString(),
        });
        setStage("pending");

        // Start background confirmation polling
        confirmContribution(it.id, hash);
      } catch (provErr: unknown) {
        const msg =
          provErr instanceof Error ? provErr.message : String(provErr);
        const lower = msg.toLowerCase();
        if (
          lower.includes("denied") ||
          lower.includes("reject") ||
          lower.includes("cancel")
        ) {
          setError("Support cancelled. No transaction was sent.");
        } else {
          setError(
            "Nimiq Pay could not send this support transaction. Your draft is safe.",
          );
        }
        setStage("error");
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Votum could not reach the support service."
          : "Could not create support intent.",
      );
      setStage("error");
    }
  }, [
    selectedOptionId,
    amountNim,
    pollId,
    provider,
    confirmContribution,
  ]);

  // ── Eligibility ────────────────────────────────────────────────────

  const canSupport = useMemo(() => {
    if (!isLive) return false;
    if (!selectedOptionId) return false;
    if (!amountNim) return false;
    if (stage !== "idle" && stage !== "error") return false;
    if (!isInsideNimiqPay) return false;
    if (walletStatus !== "connected") return false;
    if (!isSessionVerified) return false;
    if (!isWalletMatched) return false;
    return true;
  }, [
    isLive,
    selectedOptionId,
    amountNim,
    stage,
    isInsideNimiqPay,
    walletStatus,
    isSessionVerified,
    isWalletMatched,
  ]);

  const eligibilityHint = (() => {
    if (!isLive) return "This poll is closed.";
    if (!isInsideNimiqPay)
      return "Open Votum in Nimiq Pay to send NIM support.";
    if (walletStatus !== "connected")
      return "Connect your Nimiq wallet to support this option.";
    if (!isSessionVerified)
      return "Verify wallet ownership before sending NIM support.";
    if (!isWalletMatched)
      return "The connected wallet does not match the verified wallet.";
    return null;
  })();

  // minimumNim is already in NIM units — use directly for display
  const minNimDisplay = minimumNim > 0 ? minimumNim : 0;

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className={`space-y-6 ${className}`}>
      <h3 className="text-card-heading font-display text-ballot-ink">
        NIM Support
      </h3>

      {/* ── Confirmed state ── */}
      {confirmedContribution && (
        <Card className="p-5 space-y-3 bg-verified-green/[0.04] border border-verified-green/20">
          <p className="text-body font-medium text-verified-green flex items-center gap-1.5">
            <CheckIcon /> NIM support confirmed
          </p>
          <p className="text-sm text-ballot-ink">
            {options.find((o) => o.id === selectedOptionId)?.label ??
              "Your choice"}
          </p>
          <p className="text-micro text-quiet-ink">
            Your NIM was sent directly to the poll&apos;s disclosed recipient.
          </p>
          <p className="text-micro text-quiet-ink">
            One wallet · one vote. NIM support is counted separately.
          </p>
        </Card>
      )}

      {/* ── Pending state ── */}
      {stage === "pending" && !confirmedContribution && (
        <Card className="p-5 space-y-3 bg-fairness-amber/[0.04] border border-fairness-amber/20">
          <p className="text-body font-medium text-fairness-amber">
            Transaction sent — awaiting confirmation
          </p>
          <p className="text-sm text-quiet-ink">
            Your NIM support is being confirmed on the Nimiq network.
          </p>
          {txHash && (
            <p className="text-micro text-nim-blue font-proof truncate max-w-[200px]">
              {txHash}
            </p>
          )}
        </Card>
      )}

      {/* ── Error state ── */}
      {error && stage !== "pending" && (
        <p className="text-micro text-reject-red text-center" role="alert">
          {error}
        </p>
      )}

      {/* ── Support form (shown in idle / error only) ── */}
      {(stage === "idle" ||
        stage === "error" ||
        stage === "creating_intent") &&
        !confirmedContribution && (
        <Card className="p-5 space-y-4">
          {/* Option selector */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-ballot-ink">
              Option to support
            </label>
            <div className="flex flex-col gap-2">
              {options.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex items-center gap-3 p-3 rounded-card border cursor-pointer transition-colors ${
                    selectedOptionId === opt.id
                      ? "border-signal-gold bg-signal-gold/[0.04]"
                      : "border-border hover:border-micro-grey"
                  }`}
                >
                  <input
                    type="radio"
                    name="supportOption"
                    value={opt.id}
                    checked={selectedOptionId === opt.id}
                    onChange={() => setSelectedOptionId(opt.id)}
                    className="sr-only"
                  />
                  <span
                    className={`flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      selectedOptionId === opt.id
                        ? "border-signal-gold bg-signal-gold"
                        : "border-border"
                    }`}
                  >
                    {selectedOptionId === opt.id && (
                      <span className="w-1.5 h-1.5 rounded-full bg-clear-ballot" />
                    )}
                  </span>
                  <span className="text-sm text-ballot-ink">
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Amount input */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-ballot-ink">
              NIM amount
            </label>
            <Input
              type="text"
              inputMode="decimal"
              value={amountNim}
              onChange={(e) => setAmountNim(e.target.value)}
              placeholder={String(minNimDisplay)}
              hint={`Minimum support: ${minNimDisplay} NIM`}
            />
          </div>

          {/* Submit button */}
          <Button
            type="button"
            variant="primary"
            disabled={!canSupport}
            onClick={handleCreateIntent}
            className="w-full"
          >
            {stage === "creating_intent"
              ? "Preparing support…"
              : "Support with NIM"}
          </Button>

          {eligibilityHint && (
            <p className="text-micro text-quiet-ink text-center">
              {eligibilityHint}
            </p>
          )}
        </Card>
      )}

      {/* ── Public support results ── */}
      {results && (
        <Card className="p-5 space-y-3">
          <h4 className="text-sm font-medium text-ballot-ink">
            Community NIM Support
          </h4>
          {BigInt(results.totalNimLuna) === BigInt(0) ? (
            <p className="text-body text-quiet-ink text-center py-2">
              No confirmed NIM support yet.
            </p>
          ) : (
            <>
              <div className="space-y-2.5">
                {results.options.map((opt) => {
                  const lunaBig = BigInt(opt.nimLuna);
                  const totalBig = BigInt(results.totalNimLuna);
                  const pct =
                    totalBig > BigInt(0)
                      ? Number((lunaBig * BigInt(100)) / totalBig)
                      : 0;
                  return (
                    <div key={opt.optionId} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-ballot-ink">
                          {opt.label}
                        </span>
                        <span className="text-micro text-quiet-ink">
                          {formatLunaToNimCompact(opt.nimLuna)} ·{" "}
                          {opt.contributionCount} support
                          {opt.contributionCount !== 1 ? "s" : ""} · {pct}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-soft-fog overflow-hidden">
                        <div
                          className="h-full rounded-full bg-nim-blue transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-micro text-quiet-ink text-center pt-2">
                {formatLunaToNim(results.totalNimLuna)} total NIM support
              </p>
            </>
          )}
          <p className="text-micro text-quiet-ink text-center">
            One wallet · one vote. NIM support is counted separately.
          </p>
        </Card>
      )}

      {/* ── Awaiting Nimiq Pay approval ── */}
      {stage === "awaiting_approval" && (
        <Card className="p-5 text-center bg-nim-blue/[0.04] border border-nim-blue/20">
          <p className="text-body text-nim-blue font-medium">
            Confirm in Nimiq Pay
          </p>
          <p className="text-micro text-quiet-ink mt-2">
            Approve the transaction in Nimiq Pay to send your NIM support.
          </p>
        </Card>
      )}
    </div>
  );
}
