import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { getAdminConfigStatus, createAdminClient } from "@/lib/supabase/admin";
import {
  normalizeHandle,
  isValidHandle,
  isReservedHandle,
  normalizeDisplayName,
} from "@/lib/profiles/handles";
import type { ParticipantProfile } from "@/lib/profiles/types";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[profile-me]", { stage, ...data });
  }
}

const PROFILE_COLUMNS =
  "wallet_address, display_name, handle, verified_at, created_at";

function toProfile(row: Record<string, unknown>): ParticipantProfile {
  return {
    walletAddress: row.wallet_address as string,
    displayName: (row.display_name as string | null) ?? null,
    handle: (row.handle as string | null) ?? null,
    verifiedAt: row.verified_at as string,
    joinedDate: row.created_at as string,
  };
}

/**
 * GET /api/profile/me
 * Returns the current verified wallet's own profile (404 when none exists).
 */
export async function GET(): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  const { data, error } = await admin
    .from("participant_profiles")
    .select(PROFILE_COLUMNS)
    .eq("wallet_address", session.address)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json(
      { error: "profile_not_found", stage: "read", requestId, message: "No profile exists for this wallet yet." },
      { status: 404 },
    );
  }

  return NextResponse.json({ profile: toProfile(data as unknown as Record<string, unknown>) });
}

/**
 * PUT /api/profile/me
 *
 * Server-authoritative edit of the current verified wallet's profile:
 *   { displayName?: string, handle?: string }
 *
 * - The wallet is ALWAYS the session wallet; the body can never choose it.
 * - displayName: trimmed 1–40 chars, no newlines; "" clears to null.
 * - handle: canonical lowercase 3–24 [a-z0-9_], reserved set rejected, "" clears.
 * - Handle ownership is decided by the database: the update is guarded by
 *   (handle IS NULL OR handle = new) and the partial unique index — exactly
 *   one concurrent claim wins; losers receive 409 handle_taken.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");

  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_config", requestId, message: "Server not fully configured." },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_client", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", stage: "body_parse", requestId, message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "bad_request", stage: "body_validation", requestId, message: "Request body must be an object." },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;

  const hasDisplayName = "displayName" in b;
  const hasHandle = "handle" in b;
  if (!hasDisplayName && !hasHandle) {
    return NextResponse.json(
      { error: "bad_request", stage: "fields", requestId, message: "Provide displayName and/or handle." },
      { status: 400 },
    );
  }

  const updates: Record<string, string | null> = {};

  if (hasDisplayName) {
    if (typeof b.displayName !== "string") {
      return NextResponse.json(
        { error: "invalid_display_name", stage: "display_name", requestId, message: "Display name must be a string." },
        { status: 400 },
      );
    }
    const normalized = normalizeDisplayName(b.displayName);
    if (normalized === null && b.displayName.trim().length > 0) {
      return NextResponse.json(
        { error: "invalid_display_name", stage: "display_name", requestId, message: "Display name must be 1–40 characters without line breaks." },
        { status: 400 },
      );
    }
    updates.display_name = normalized; // null clears
  }

  if (hasHandle) {
    if (typeof b.handle !== "string") {
      return NextResponse.json(
        { error: "invalid_handle", stage: "handle", requestId, message: "Handle must be a string." },
        { status: 400 },
      );
    }
    if (b.handle.trim() === "") {
      updates.handle = null; // clearing is conflict-free
    } else {
      const normalized = normalizeHandle(b.handle);
      if (!isValidHandle(normalized)) {
        return NextResponse.json(
          { error: "invalid_handle", stage: "handle", requestId, message: "Handles are 3–24 characters: letters, numbers, underscore." },
          { status: 400 },
        );
      }
      if (isReservedHandle(normalized)) {
        return NextResponse.json(
          { error: "reserved_handle", stage: "handle", requestId, message: "That handle is reserved." },
          { status: 409 },
        );
      }
      updates.handle = normalized;
    }
  }

  // The wallet must already have a profile (bootstrap first).
  const { data: existing } = await admin
    .from("participant_profiles")
    .select("wallet_address, handle")
    .eq("wallet_address", session.address)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json(
      { error: "profile_not_found", stage: "ownership", requestId, message: "No profile exists for this wallet yet." },
      { status: 404 },
    );
  }

  const nowIso = new Date().toISOString();

  // Single guarded update. Handle ownership is decided entirely by the
  // partial unique index: setting a handle owned by another wallet raises
  // unique violation 23505 → 409. Concurrent claims produce exactly one
  // winner; the loser sees the violation. Re-applying your own handle or
  // clearing it are no-op success paths.
  const { data, error } = await admin
    .from("participant_profiles")
    .update({ ...updates, updated_at: nowIso })
    .eq("wallet_address", session.address)
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "handle_taken", stage: "handle", requestId, message: "That handle is already taken." },
        { status: 409 },
      );
    }
    log("edit_update_failed", { requestId, status: 500, code: error.code });
    return NextResponse.json(
      { error: "edit_failed", stage: "update", requestId, message: "Could not update the profile." },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "handle_taken", stage: "handle", requestId, message: "That handle is already taken." },
      { status: 409 },
    );
  }

  return NextResponse.json({ profile: toProfile(data as unknown as Record<string, unknown>) });
}
