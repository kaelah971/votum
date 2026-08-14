/**
 * V2B.1 return-to-intent path validation.
 *
 * Return targets must be internal Votum routes. External URLs, protocol-
 * relative paths, backslash paths, scheme-bearing strings, and unsupported
 * top-level prefixes are rejected. Redirects are executed client-side only.
 */

const SPECIFIC_PREFIXES = [
  "/explore",
  "/create",
  "/how-it-works",
  "/polls/",
  "/my-polls",
  "/drafts",
  "/insights",
  "/profile",
  "/u/",
] as const;

/**
 * True only for safe internal destination paths.
 *
 * - must be a non-empty string starting with a single "/"
 * - must not start with "//" (protocol-relative) or "/\" 
 * - must not contain ":" (blocks schemes like https:, javascript:, mailto:)
 * - must not contain "\" anywhere
 * - must be "/" (home) or match a known internal prefix
 */
export function isSafeInternalReturnPath(
  path: string | null | undefined,
): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.startsWith("/\\")) return false;
  if (path.includes(":") || path.includes("\\")) return false;

  if (path === "/") return true;
  return SPECIFIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}
