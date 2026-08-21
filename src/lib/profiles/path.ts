/**
 * Route-safe path segment for a wallet profile link.
 *
 * The canonical /profile/[wallet] route accepts canonical hex or user-friendly
 * NQ forms. Human-readable NQ addresses include cosmetic spaces that become
 * URL-encoded `%20` in a dynamic route segment; the route handler receives
 * the segment still `%20`-encoded, which the address normaliser cannot parse.
 * Stripping whitespace yields the space-free NQ form the lookup layer already
 * accepts — the same canonical wallet identity, rendered route-safely.
 */
export function profileWalletPath(wallet: string): string {
  return wallet.replace(/\s+/g, "");
}
