"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { signMessage } from "@/lib/nimiq/client";

export type ClaimPhase =
  | "idle"
  | "requesting_challenge"
  | "awaiting_signature"
  | "submitting_claim"
  | "done"
  | "error";

export interface CampaignClaimReceipt {
  receiptId: string;
  settlementId: string;
  status: string;
  replayed: boolean;
}

export interface UseCampaignClaimState {
  phase: ClaimPhase;
  receipt: CampaignClaimReceipt | null;
  errorCode: string | null;
  start: () => Promise<void>;
  reset: () => void;
}

/** One initial attempt plus one fresh-challenge retry. Never more. */
const MAX_CHALLENGE_ATTEMPTS = 2;

const RETRYABLE_CHALLENGE_CODES = new Set(["challenge_expired", "challenge_consumed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverCode(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body.reasonCode === "string" && body.reasonCode.length > 0) return body.reasonCode;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  }
  return fallback;
}

function parseChallenge(body: unknown): { challengeId: string; message: string } | null {
  if (!isRecord(body)) return null;
  if (typeof body.challengeId !== "string" || body.challengeId.length === 0) return null;
  if (typeof body.message !== "string" || body.message.length === 0) return null;
  return { challengeId: body.challengeId, message: body.message };
}

function parseReceipt(body: unknown): CampaignClaimReceipt | null {
  if (!isRecord(body)) return null;
  if (typeof body.receiptId !== "string" || body.receiptId.length === 0) return null;
  if (typeof body.settlementId !== "string" || body.settlementId.length === 0) return null;
  if (typeof body.status !== "string" || body.status.length === 0) return null;
  return {
    receiptId: body.receiptId,
    settlementId: body.settlementId,
    status: body.status,
    replayed: body.replayed === true,
  };
}

/**
 * Participant Claim NIM flow: server challenge, wallet signature over the
 * exact returned message bytes, signed claim submit. Identity comes only
 * from the verified wallet/session stack; amounts, settlements, and
 * entitlements are never client-chosen. Stale challenges get exactly one
 * bounded fresh-challenge retry; nothing here resends value or creates
 * client-side entitlements.
 */
export function useCampaignClaim(campaignId: string): UseCampaignClaimState {
  const { provider, activeAccount } = useNimiqContext();
  const { isSessionVerified, isWalletMatched, verifiedWalletAddress } = useVotumSession();
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [receipt, setReceipt] = useState<CampaignClaimReceipt | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fail = useCallback((code: string) => {
    if (!mountedRef.current) return;
    setPhase("error");
    setErrorCode(code);
    setReceipt(null);
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setErrorCode(null);
    setReceipt(null);
  }, []);

  const start = useCallback(async () => {
    const wallet = verifiedWalletAddress ?? activeAccount;
    if (!provider || !isSessionVerified || !isWalletMatched || !wallet) {
      fail("session_missing");
      return;
    }

    for (let attempt = 0; attempt < MAX_CHALLENGE_ATTEMPTS; attempt += 1) {
      if (!mountedRef.current) return;
      setPhase("requesting_challenge");
      let challengeBody: unknown;
      try {
        const challengeRes = await fetch(`/api/campaigns/${campaignId}/claims/challenge`, {
          method: "POST",
        });
        challengeBody = await challengeRes.json().catch(() => null);
        if (!challengeRes.ok) {
          const code = serverCode(challengeBody, "challenge_failed");
          if (attempt + 1 < MAX_CHALLENGE_ATTEMPTS && RETRYABLE_CHALLENGE_CODES.has(code)) continue;
          fail(code);
          return;
        }
      } catch {
        fail("claim_failed");
        return;
      }

      const challenge = parseChallenge(challengeBody);
      if (!challenge) {
        fail("claim_failed");
        return;
      }

      if (!mountedRef.current) return;
      setPhase("awaiting_signature");
      const signed = await signMessage(provider, challenge.message);
      if ("denied" in signed) {
        fail("signature_rejected");
        return;
      }
      if ("error" in signed) {
        fail("signature_failed");
        return;
      }

      if (!mountedRef.current) return;
      setPhase("submitting_claim");
      try {
        const claimRes = await fetch(`/api/campaigns/${campaignId}/claims`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            address: wallet,
            publicKey: signed.publicKey,
            signature: signed.signature,
          }),
        });
        const claimBody: unknown = await claimRes.json().catch(() => null);
        if (!claimRes.ok) {
          const code = serverCode(claimBody, "claim_failed");
          if (attempt + 1 < MAX_CHALLENGE_ATTEMPTS && RETRYABLE_CHALLENGE_CODES.has(code)) continue;
          fail(code);
          return;
        }
        const parsed = parseReceipt(claimBody);
        if (!parsed) {
          fail("claim_failed");
          return;
        }
        if (!mountedRef.current) return;
        setReceipt(parsed);
        setErrorCode(null);
        setPhase("done");
        return;
      } catch {
        fail("claim_failed");
        return;
      }
    }

    fail("claim_failed");
  }, [provider, activeAccount, isSessionVerified, isWalletMatched, verifiedWalletAddress, campaignId, fail]);

  return { phase, receipt, errorCode, start, reset };
}
