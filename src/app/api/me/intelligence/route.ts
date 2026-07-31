import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/intelligence
 *
 * Returns creator intelligence for the currently authenticated wallet.
 * The creator wallet is derived exclusively from the verified session —
 * never from query parameters or request body.
 *
 * The Supabase RPC `get_creator_intelligence(_creator_wallet text)`
 * returns a jsonb payload with `{ summary, polls, activity }`.
 * Only the `service_role` key has EXECUTE privilege; PUBLIC / anon /
 * authenticated are revoked so this route always uses the admin client.
 */
export async function GET() {
  const requestId = randomBytes(8).toString("hex");

  // ── Session ──────────────────────────────────────────────────────
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      {
        error: "session_missing",
        stage: "session",
        requestId,
        message: "A verified wallet session is required.",
      },
      { status: 401 },
    );
  }

  // ── Admin client ─────────────────────────────────────────────────
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin",
        requestId,
        message: "Server not configured.",
      },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin",
        requestId,
        message: "Admin client unavailable.",
      },
      { status: 503 },
    );
  }

  // ── RPC call ─────────────────────────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc(
      "get_creator_intelligence",
      {
        _creator_wallet: session.address,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    if (error) {
      console.error("[intelligence]", {
        stage: "rpc_failed",
        requestId,
        code: error.code,
        message: error.message,
      });
      return NextResponse.json(
        {
          error: "intelligence_unavailable",
          stage: "rpc",
          requestId,
          message: "Could not retrieve creator intelligence.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("[intelligence]", {
      stage: "unexpected",
      requestId,
      error: String(err),
    });
    return NextResponse.json(
      {
        error: "intelligence_unavailable",
        stage: "server",
        requestId,
        message: "Could not retrieve creator intelligence.",
      },
      { status: 500 },
    );
  }
}
