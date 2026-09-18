"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProofReference } from "@/components/ui/ProofReference";

/** Interval for non-terminal claim polling. Modest by design: payout status moves slowly. */
const POLL_INTERVAL_MS = 15_000;

type ClaimedStatus = "reserved" | "payout_pending" | "paid" | "retryable";

interface ClaimedView {
  kind: "claimed";
  status: ClaimedStatus;
  receiptId: string;
  paidAt: string | null;
  transactionHash: string | null;
}

type PanelView =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "unavailable" }
  | { kind: "session" }
  | ClaimedView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaimed(body: unknown): ClaimedView | "empty" | null {
  if (!isRecord(body)) return null;
  if (body.claimed === false) return "empty";
  if (body.claimed !== true) return null;
  if (
    typeof body.status !== "string" ||
    !["reserved", "payout_pending", "paid", "retryable"].includes(body.status) ||
    typeof body.receiptId !== "string" ||
    body.receiptId.length === 0
  ) {
    return null;
  }
  return {
    kind: "claimed",
    status: body.status as ClaimedStatus,
    receiptId: body.receiptId,
    paidAt: typeof body.paidAt === "string" ? body.paidAt : null,
    transactionHash: typeof body.transactionHash === "string" ? body.transactionHash : null,
  };
}

function formatDateTime(value: string): string {
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

function InfoIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className={`flex-shrink-0 ${className}`}>
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7 6.5V10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="7" cy="4.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`flex-shrink-0 ${className}`}>
      <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface CampaignClaimStatusProps {
  campaignId: string;
  /** When false, renders nothing and performs no fetches. E3 owns composition. */
  enabled?: boolean;
  /**
   * Changing value triggers one immediate refresh (e.g. right after a
   * successful claim). Optional; polling continues to work without it.
   */
  refreshSignal?: number;
  /**
   * Reports whether the server currently holds a claim for this viewer.
   * Optional; display behavior is unchanged without it.
   */
  onClaimedChange?: (claimed: boolean) => void;
  className?: string;
}

/**
 * Durable participant claim status, recovered entirely from
 * GET /api/campaigns/[campaignId]/claims/mine with zero E1 memory, so a
 * reload rediscovers reserved/sending/confirming/paid/delayed without
 * re-signing. Polls while non-terminal plus on window focus; paid,
 * session-missing, and unavailable states stop the poller. Late responses
 * can never regress a newer known state. Never renders retry, resend, or
 * broadcast controls.
 */
export function CampaignClaimStatus({ campaignId, enabled = true, refreshSignal = 0, onClaimedChange, className = "" }: CampaignClaimStatusProps) {
  const [view, setView] = useState<PanelView>({ kind: "loading" });
  const viewRef = useRef<PanelView>({ kind: "loading" });
  const sequenceRef = useRef(0);
  const appliedRef = useRef(0);
  const stoppedRef = useRef(false);
  const mountedRef = useRef(true);
  const onClaimedChangeRef = useRef(onClaimedChange);
  useEffect(() => {
    onClaimedChangeRef.current = onClaimedChange;
  }, [onClaimedChange]);

  const applyView = useCallback((next: PanelView, id: number) => {
    if (!mountedRef.current || id < appliedRef.current) return;
    appliedRef.current = id;
    viewRef.current = next;
    setView(next);
    if (next.kind === "claimed" || next.kind === "empty") {
      onClaimedChangeRef.current?.(next.kind === "claimed");
    }
    if (
      next.kind === "session" ||
      next.kind === "unavailable" ||
      (next.kind === "claimed" && next.status === "paid")
    ) {
      stoppedRef.current = true;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || stoppedRef.current) return;
    const id = (sequenceRef.current += 1);
    let res: Response;
    try {
      res = await fetch(`/api/campaigns/${campaignId}/claims/mine`);
    } catch {
      return;
    }
    if (!mountedRef.current) return;
    if (res.status === 401) {
      applyView({ kind: "session" }, id);
      return;
    }
    if (res.status === 404) {
      applyView({ kind: "unavailable" }, id);
      return;
    }
    if (!res.ok) return;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return;
    }
    if (!mountedRef.current) return;
    const parsed = parseClaimed(body);
    if (parsed === null) return;
    applyView(parsed === "empty" ? { kind: "empty" } : parsed, id);
  }, [campaignId, applyView]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    stoppedRef.current = false;
    void refresh();
    const interval = window.setInterval(() => {
      const current = viewRef.current;
      if (current.kind === "claimed" && current.status === "paid") return;
      void refresh();
    }, POLL_INTERVAL_MS);
    const onFocus = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [campaignId, enabled, refresh]);

  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    stoppedRef.current = false;
    void refresh();
  }, [refreshSignal, refresh]);

  if (!enabled) return null;

  if (view.kind === "loading" || view.kind === "empty") return null;

  if (view.kind === "session") {
    return (
      <div className={className}>
        <p className="text-body text-quiet-ink">Session unavailable</p>
      </div>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <div className={className}>
        <p className="text-body text-quiet-ink">Campaign unavailable</p>
      </div>
    );
  }

  const title =
    view.status === "reserved"
      ? "Claim reserved"
      : view.status === "payout_pending"
        ? view.transactionHash
          ? "Confirming payment"
          : "Sending NIM"
        : view.status === "paid"
          ? "Paid"
          : "Payout delayed";
  const isPaid = view.status === "paid";
  const detail =
    view.status === "reserved"
      ? "Your reward is secured for this wallet. Payment has not been sent yet."
      : view.status === "payout_pending" && !view.transactionHash
        ? "Your payout is being prepared. No confirmed payment proof yet."
        : view.status === "payout_pending"
          ? "Your transaction is broadcast. Waiting for on-chain confirmation."
          : view.status === "paid"
            ? "Payment confirmed for this wallet."
            : "Your claim remains reserved. Payout needs more time on our side — no action needed.";

  return (
    <div className={`rounded-thumbnail border border-divider bg-soft-fog px-4 py-3 ${className}`}>
      <p className={`flex items-center gap-2 text-body font-medium ${isPaid ? "text-verified-green" : "text-ballot-ink"}`}>
        {isPaid ? <CheckIcon /> : <InfoIcon />}
        {title}
      </p>
      <p className="mt-1 text-micro text-quiet-ink">{detail}</p>
      {view.transactionHash ? (
        <div className="mt-3">
          <ProofReference
            txHash={view.transactionHash}
            timestamp={view.paidAt ? formatDateTime(view.paidAt) : undefined}
          />
        </div>
      ) : null}
      <p className="mt-2 font-proof text-proof text-quiet-ink">
        Receipt {view.receiptId.length > 18 ? `${view.receiptId.slice(0, 8)}…${view.receiptId.slice(-4)}` : view.receiptId}
      </p>
    </div>
  );
}
