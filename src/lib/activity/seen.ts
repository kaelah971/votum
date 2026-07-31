"use client";

const KEY = "votum_creator_activity_seen_v1";

export function getLastSeenAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.lastSeenAt === "string" ? parsed.lastSeenAt : null;
  } catch {
    return null;
  }
}

export function setLastSeenAt(iso: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ lastSeenAt: iso }));
  } catch {
    // storage unavailable
  }
}
