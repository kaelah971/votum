"use client";

const KEY_PREFIX = "votum_pending_reward_funding_v1";

export interface PendingRewardFunding {
  pollId: string;
  campaignId: string;
  fundingIntentId: string;
  transactionHash: string;
  submittedAt: string;
}

export function getPendingRewardFunding(pollId: string): PendingRewardFunding | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}:${pollId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRewardFunding>;
    if (
      typeof parsed.pollId !== "string" ||
      typeof parsed.campaignId !== "string" ||
      typeof parsed.fundingIntentId !== "string" ||
      typeof parsed.transactionHash !== "string" ||
      typeof parsed.submittedAt !== "string"
    ) {
      return null;
    }
    return parsed as PendingRewardFunding;
  } catch {
    return null;
  }
}

export function setPendingRewardFunding(data: PendingRewardFunding): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${KEY_PREFIX}:${data.pollId}`, JSON.stringify(data));
  } catch {
    // Storage is only a resume aid; the server intent remains authoritative.
  }
}

export function clearPendingRewardFunding(pollId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${KEY_PREFIX}:${pollId}`);
  } catch {
    // Storage may be unavailable in a restricted wallet browser.
  }
}
