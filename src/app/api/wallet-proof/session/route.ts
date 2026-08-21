import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { toUserFriendlyAddress } from "@/lib/nimiq/server-crypto";

export const runtime = "nodejs";

/**
 * GET /api/wallet-proof/session
 *
 * Returns the current verified wallet session, if any.
 * Missing / expired / revoked sessions are not errors —
 * the caller simply receives `{ verified: false }`.
 *
 * `walletAddress` is returned in the user-friendly NQ display form so the
 * client can compare it against the wallet SDK's `activeAccount` using the
 * shared canonical identity key — the stored session row uses canonical hex.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getVerifiedWalletSession();

  if (session) {
    return NextResponse.json({
      verified: true,
      walletAddress: toUserFriendlyAddress(session.address) ?? session.address,
    });
  }

  return NextResponse.json({ verified: false });
}
