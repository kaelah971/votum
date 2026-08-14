import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeHandle, isValidHandle, isReservedHandle } from "@/lib/profiles/handles";

export const runtime = "nodejs";

/**
 * GET /api/profile/me/availability?handle=<handle>
 *
 * UX assistance ONLY. Returns whether a normalized handle appears free.
 * The database unique index remains the sole authority — this endpoint is
 * inherently racy by design and never grants ownership.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("handle");
  if (typeof raw !== "string" || raw.length === 0) {
    return NextResponse.json(
      { error: "invalid_handle", stage: "validation", requestId, message: "handle query parameter is required." },
      { status: 400 },
    );
  }

  const handle = normalizeHandle(raw);
  if (!isValidHandle(handle)) {
    return NextResponse.json(
      { error: "invalid_handle", stage: "validation", requestId, message: "Handles are 3–24 characters: letters, numbers, underscore." },
      { status: 400 },
    );
  }
  if (isReservedHandle(handle)) {
    return NextResponse.json({ available: false, reason: "reserved" });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  const { data } = await admin
    .from("participant_profiles")
    .select("wallet_address")
    .eq("handle", handle)
    .maybeSingle();

  if (data) {
    return NextResponse.json({ available: false, reason: "taken" });
  }
  return NextResponse.json({ available: true, reason: "free" });
}
