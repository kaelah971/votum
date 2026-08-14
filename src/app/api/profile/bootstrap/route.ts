import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { getAdminConfigStatus, createAdminClient } from "@/lib/supabase/admin";
import { ensureParticipantProfile } from "@/lib/profiles/bootstrap";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[profile-bootstrap]", { stage, ...data });
  }
}

/**
 * POST /api/profile/bootstrap
 *
 * Creates (or loads) the participant profile for the wallet of the current
 * verified session. The wallet is taken ONLY from the server-side session —
 * the request body is ignored. No verified session → no profile creation.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");

  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
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

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    log("admin_unconfigured", { requestId, status: 503 });
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_config",
        requestId,
        message: "Server not fully configured.",
      },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    log("admin_client_null", { requestId, status: 503 });
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_client",
        requestId,
        message: "Admin client unavailable.",
      },
      { status: 503 },
    );
  }

  // request body intentionally ignored — session wallet is authoritative.
  void request;

  const profile = await ensureParticipantProfile(session.address);
  if (!profile) {
    log("bootstrap_failed", { requestId, status: 500 });
    return NextResponse.json(
      {
        error: "bootstrap_failed",
        stage: "bootstrap",
        requestId,
        message: "Could not create the participant profile.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ profile });
}
