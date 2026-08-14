import "server-only";
import { createServerClient } from "@/lib/supabase/config";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { normalizeHandle, isValidHandle } from "./handles";
import { serializePublicProfile } from "./serialize";
import type { ParticipantPublicProfile } from "./types";

/**
 * V2B.1 public profile query layer.
 *
 * Reads go through the anonymous publishable key and the two SECURITY
 * DEFINER RPCs (the get_public_poll_results pattern), because
 * participant_profiles is RLS-revoked from anon. Every payload is reduced
 * through the deep allowlist serializer — anything beyond the approved public
 * fields is dropped by construction.
 */

async function rpcProfile(
  fn: "get_participant_public_profile" | "get_participant_public_profile_by_handle",
  arg: { _wallet: string } | { _handle: string },
): Promise<ParticipantPublicProfile | null> {
  const client = createServerClient();
  if (!client) return null;

  const { data, error } = await client.rpc(fn, arg);
  if (error || data === null || typeof data !== "object") return null;

  const result = data as Record<string, unknown>;
  if (result.result_kind !== "found") return null;
  return serializePublicProfile(result);
}

/** Resolve by canonical hex or user-friendly NQ wallet address. */
export async function getPublicProfileByWallet(
  raw: string,
): Promise<ParticipantPublicProfile | null> {
  const canonical = normalizeAddress(raw);
  if (!canonical) return null;
  return rpcProfile("get_participant_public_profile", { _wallet: canonical });
}

/** Resolve by handle (canonical lowercase; case-insensitive input). */
export async function getPublicProfileByHandle(
  raw: string,
): Promise<ParticipantPublicProfile | null> {
  const canonical = normalizeHandle(raw);
  if (!isValidHandle(canonical)) return null;
  return rpcProfile("get_participant_public_profile_by_handle", { _handle: canonical });
}
