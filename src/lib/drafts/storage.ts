"use client";

import type { PollDraft } from "./types";
import { createUuidV4 } from "@/lib/uuid";

const STORAGE_KEY = "votum_poll_drafts_v1";

function readAll(): PollDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter out malformed entries
    return parsed.filter(
      (d: unknown) =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as PollDraft).id === "string",
    ) as PollDraft[];
  } catch {
    return [];
  }
}

function writeAll(drafts: PollDraft[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Storage full or unavailable
  }
}

export function listDrafts(): PollDraft[] {
  return readAll().sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function getDraft(id: string): PollDraft | null {
  const drafts = readAll();
  return drafts.find((d) => d.id === id) ?? null;
}

export function createDraft(draft: PollDraft): void {
  const drafts = readAll();
  drafts.push(draft);
  writeAll(drafts);
}

export function updateDraft(
  id: string,
  partial: Partial<PollDraft>,
): PollDraft | null {
  const drafts = readAll();
  const index = drafts.findIndex((d) => d.id === id);
  if (index === -1) return null;
  drafts[index] = {
    ...drafts[index],
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  writeAll(drafts);
  return drafts[index];
}

export function deleteDraft(id: string): void {
  const drafts = readAll().filter((d) => d.id !== id);
  writeAll(drafts);
}

/**
 * Ensures the draft has a publication idempotency key, generating one
 * if necessary. Returns the key (existing or newly created).
 */
export function ensurePublicationKey(draftId: string): string {
  const draft = getDraft(draftId);
  if (!draft) throw new Error("Draft not found");
  if (draft.publicationIdempotencyKey) return draft.publicationIdempotencyKey;
  const key = createUuidV4();
  updateDraft(draftId, { publicationIdempotencyKey: key } as Partial<PollDraft>);
  return key;
}

/**
 * Called after successful poll publication to remove the draft.
 */
export function markDraftPublishedOrDelete(id: string): void {
  deleteDraft(id);
}
