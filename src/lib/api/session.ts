import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

const SESSION_COOKIE = "votum_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Hash a raw token using SHA-256 so token_hash never appears in logs
 * or database in plaintext form.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a cryptographically-random URL-safe token for session cookies.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Look up a verified wallet session from the request cookie.
 *
 * Performs all standard checks:
 *  1. Cookie present
 *  2. Matching row exists in wallet_sessions
 *  3. Session not revoked
 *  4. Session not expired
 *
 * Returns `{ address }` on success, `null` otherwise.
 * Updates `last_seen_at` as a fire-and-forget side-effect.
 */
export async function getVerifiedWalletSession(): Promise<{
  address: string;
} | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const hashed = hashToken(token);
  const admin = createAdminClient();
  if (!admin) return null;

  try {
    const { data, error } = await admin
      .from("wallet_sessions")
      .select("wallet_address, expires_at, revoked_at")
      .eq("token_hash", hashed)
      .single();

    if (error || !data) return null;
    if (data.revoked_at) return null;
    if (new Date(data.expires_at) < new Date()) return null;

    // Update last_seen_at (non-blocking, fire-and-forget)
    admin
      .from("wallet_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("token_hash", hashed)
      .then(() => {
        /* intentionally no-op */
      });

    return { address: data.wallet_address };
  } catch {
    return null;
  }
}

/**
 * Determine whether the `Secure` flag should be set on cookies.
 *
 * Matches the logic in the wallet-proof verify route: Secure is only
 * enabled when running in production AND an APP_URL is configured.
 * On local HTTP production (no APP_URL set), Secure=false so the
 * session cookie works over plain HTTP on the local network.
 */
function isSecureOrigin(): boolean {
  return process.env.NODE_ENV === "production" && !!process.env.NEXT_PUBLIC_APP_URL;
}

/**
 * Set the httpOnly session cookie with a given raw token.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureOrigin(),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/**
 * Clear the session cookie (used on logout or invalid session).
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureOrigin(),
    path: "/",
    maxAge: 0,
  });
}
