import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ParticipantProfile } from "./types";

/**
 * V2B.1 profile bootstrap.
 *
 * Creates exactly one participant profile per verified wallet. The wallet is
 * always derived from the trusted server-side session — this function NEVER
 * accepts a caller-chosen wallet. Idempotent: repeated calls load the same
 * profile and never touch existing display_name / handle / verified_at.
 */

interface ProfileRow {
  wallet_address: string;
  display_name: string | null;
  handle: string | null;
  verified_at: string;
  created_at: string;
}

function toParticipantProfile(row: ProfileRow): ParticipantProfile {
  return {
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    handle: row.handle,
    verifiedAt: row.verified_at,
    joinedDate: row.created_at,
  };
}

const PROFILE_COLUMNS =
  "wallet_address, display_name, handle, verified_at, created_at";

export async function ensureParticipantProfile(
  walletAddress: string,
): Promise<ParticipantProfile | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  // INSERT ... ON CONFLICT DO NOTHING — an existing profile is never
  // overwritten (display_name, handle, verified_at all preserved).
  const { data, error } = await admin
    .from("participant_profiles")
    .upsert(
      { wallet_address: walletAddress },
      { onConflict: "wallet_address", ignoreDuplicates: true },
    )
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) return null;
  if (data) return toParticipantProfile(data as unknown as ProfileRow);

  // Conflict path: row already existed, load it as-is.
  const { data: existing, error: existingErr } = await admin
    .from("participant_profiles")
    .select(PROFILE_COLUMNS)
    .eq("wallet_address", walletAddress)
    .maybeSingle();

  if (existingErr || !existing) return null;
  return toParticipantProfile(existing as unknown as ProfileRow);
}
