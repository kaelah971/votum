/**
 * V2B.1 handle validation rules.
 *
 * Server-authoritative: every edit endpoint re-validates with these helpers,
 * and the database partial unique index on participant_profiles.handle is the
 * final arbiter of uniqueness (exactly one concurrent claim wins). Client-side
 * checks and availability hints are UX only.
 */

/** Reserved system handles — must mirror the approved V2B.1 design. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin", "administrator", "admins", "votum", "support", "api", "explore",
  "profile", "settings", "login", "logout", "create", "how-it-works",
  "howitworks", "my-polls", "mypolls", "drafts", "insights", "polls", "poll",
  "u", "receipt", "account", "wallet", "wallets", "home", "about", "help",
  "feedback", "privacy", "terms", "faq", "notifications", "vote", "votes",
  "voting", "signal", "signals", "nim", "nimiq", "verified", "signup",
  "signin", "register", "staff", "team", "system", "root", "mod",
  "moderator", "test", "debug", "example", "user", "users",
]);

/** Canonical lowercase form of a handle input. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Valid handle: canonical lowercase, 3–24 chars, ASCII letters, digits,
 * underscore. Mirrors the DB CHECK on participant_profiles.handle.
 */
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{3,24}$/.test(handle);
}

/** True when the (already normalized) handle is on the reserved list. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle);
}

/**
 * Full validation pipeline: normalize, then check format and reserved set.
 * Returns a canonical handle or null when invalid.
 */
export function validateHandle(raw: string): string | null {
  const normalized = normalizeHandle(raw);
  if (!isValidHandle(normalized) || isReservedHandle(normalized)) return null;
  return normalized;
}

/** Optional display name: trimmed, 1–40 chars, no newlines. Empty → null. */
export function normalizeDisplayName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 40) return null;
  if (trimmed.includes("\n")) return null;
  return trimmed;
}
