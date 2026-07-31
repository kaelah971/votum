"use client";

const KEY_PREFIX = "votum_pending_nim_support_v1";

interface PendingSupport {
  pollId: string;
  intentId: string;
  transactionHash: string;
  optionId: string;
  submittedAt: string;
}

export function getPendingSupport(pollId: string): PendingSupport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}:${pollId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.pollId !== "string" ||
      typeof parsed?.intentId !== "string" ||
      typeof parsed?.transactionHash !== "string"
    )
      return null;
    return parsed as PendingSupport;
  } catch {
    return null;
  }
}

export function setPendingSupport(data: PendingSupport): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      `${KEY_PREFIX}:${data.pollId}`,
      JSON.stringify(data),
    );
  } catch {
    // Storage quota exceeded or unavailable — silently ignore.
  }
}

export function clearPendingSupport(pollId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${KEY_PREFIX}:${pollId}`);
  } catch {
    // Silently ignore.
  }
}
