import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, clearSessionCookie } from "@/lib/api/session";

export const runtime = "nodejs";

const SESSION_COOKIE = "votum_session";

/**
 * POST /api/wallet-proof/logout
 *
 * Revokes the current session server-side and clears the cookie.
 * Idempotent — always returns success even if no session exists.
 */
export async function POST(): Promise<NextResponse> {
  // ── 1. Read session cookie token ─────────────────────────────────────
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    // ── 2. Hash and revoke ─────────────────────────────────────────────
    const hashed = hashToken(token);
    const admin = createAdminClient();

    if (admin) {
      try {
        await admin
          .from("wallet_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("token_hash", hashed)
          .is("revoked_at", null);
      } catch {
        // Ignore — logout should always succeed from the user's perspective.
        // The session row will naturally expire regardless.
      }
    }
  }

  // ── 3. Clear cookie ──────────────────────────────────────────────────
  await clearSessionCookie();

  return NextResponse.json({ success: true });
}
