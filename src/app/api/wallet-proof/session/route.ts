import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";

export const runtime = "nodejs";

/**
 * GET /api/wallet-proof/session
 *
 * Returns the current verified wallet session, if any.
 * Missing / expired / revoked sessions are not errors —
 * the caller simply receives `{ verified: false }`.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getVerifiedWalletSession();

  if (session) {
    return NextResponse.json({
      verified: true,
      walletAddress: session.address,
    });
  }

  return NextResponse.json({ verified: false });
}
