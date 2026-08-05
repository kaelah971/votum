/**
 * V2A.7 Opaque Cursor Contract
 *
 * Cursors are base64url-encoded JSON objects carrying the ordering
 * key needed to continue deterministic pagination.  They are never
 * written into the shareable Explore URL.
 *
 * decodeCursor is total: it never throws for untrusted input.
 */

import type { ExploreSortMode, PollSection } from "@/lib/explore/filters";

// ── Cursor payload ────────────────────────────────────────────────────

export interface CursorPayload {
  /** Cursor format version for forward compatibility. */
  v: 1;
  /** The sort mode this cursor was created for. */
  sort: ExploreSortMode;
  /** For grouped mode, the section this cursor belongs to (undefined for flat). */
  section?: PollSection;
  /**
   * Ordering key: [primary_value, poll_id].
   * primary_value is the timestamp string (ISO) or the string "null"
   * for null timestamps.
   */
  key: [string, string];
}

// ── Valid sort modes (mirrors ExploreSortMode for runtime validation) ──

const VALID_SORTS: ReadonlySet<string> = new Set(["grouped", "recent", "closing"]);
const VALID_SECTIONS: ReadonlySet<string> = new Set([
  "closing_soon",
  "live_now",
  "recently_closed",
]);

// ── Encoding ──────────────────────────────────────────────────────────

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

// ── Decoding (total — never throws) ────────────────────────────────────

export function decodeCursor(cursor: string): CursorPayload | null {
  if (typeof cursor !== "string" || cursor.trim() === "") return null;

  // 1. Decode base64url
  let json: string;
  try {
    json = Buffer.from(cursor, "base64url").toString("utf-8");
  } catch {
    return null;
  }

  // 2. Parse JSON
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }

  // 3. Validate shape (must be a non-null object)
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  // 4. Version
  if (obj.v !== 1) return null;

  // 5. Sort
  if (typeof obj.sort !== "string" || !VALID_SORTS.has(obj.sort)) return null;

  // 6. Section (optional, but must be valid if present)
  if (
    obj.section !== undefined &&
    (typeof obj.section !== "string" || !VALID_SECTIONS.has(obj.section))
  ) {
    return null;
  }

  // 7. Key — must be a 2-element array of strings
  if (!Array.isArray(obj.key) || obj.key.length !== 2) return null;
  if (typeof obj.key[0] !== "string" || typeof obj.key[1] !== "string") return null;

  return {
    v: 1,
    sort: obj.sort as ExploreSortMode,
    section: obj.section as PollSection | undefined,
    key: [obj.key[0] as string, obj.key[1] as string],
  };
}
