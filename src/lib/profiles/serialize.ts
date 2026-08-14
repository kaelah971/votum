import type { ParticipantPublicProfile } from "./types";

/**
 * V2B.1 public profile serializer — the deep allowlist.
 *
 * Builds a ParticipantPublicProfile by picking ONLY the approved public keys
 * from an untrusted payload (e.g. RPC jsonb). Any field not on the allowlist
 * — session tokens, token hashes, challenge data, option ids/labels, internal
 * fields — is dropped by construction. Returns null when the payload cannot
 * be reduced to the approved shape.
 */

const PROFILE_KEYS = new Set([
  "walletAddress",
  "displayName",
  "handle",
  "verifiedAt",
  "joinedDate",
]);

const STAT_KEYS = new Set([
  "pollsCreated",
  "participations",
  "nimSupportedLuna",
  "nimEarnedLuna",
]);

const ACTIVITY_KEYS = new Set(["kind", "pollId", "question", "at"]);

/** Picks exactly `keys` from a record; null when any key is missing. */
function pickRecord(
  raw: unknown,
  keys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in source)) return null;
    out[key] = source[key];
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function serializePublicProfile(raw: unknown): ParticipantPublicProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as Record<string, unknown>;

  const statsRaw = pickRecord(payload.stats, STAT_KEYS);
  if (!statsRaw) return null;
  const pollsCreated = num(statsRaw.pollsCreated);
  const participations = num(statsRaw.participations);
  const nimSupportedLuna = str(statsRaw.nimSupportedLuna);
  const nimEarnedLuna = str(statsRaw.nimEarnedLuna);
  if (pollsCreated === null || participations === null ||
      nimSupportedLuna === null || nimEarnedLuna === null) {
    return null;
  }

  const activityRaw = payload.activity;
  if (!Array.isArray(activityRaw)) return null;
  const activity: ParticipantPublicProfile["activity"] = [];
  for (const item of activityRaw) {
    const picked = pickRecord(item, ACTIVITY_KEYS);
    if (!picked) return null;
    if (picked.kind !== "created" && picked.kind !== "participated") return null;
    const pollId = str(picked.pollId);
    const question = str(picked.question);
    const at = str(picked.at);
    if (pollId === null || question === null || at === null) return null;
    activity.push({ kind: picked.kind, pollId, question, at });
  }

  const profileRaw = payload.profile;
  if (profileRaw === null) {
    return {
      profile: null,
      stats: { pollsCreated, participations, nimSupportedLuna, nimEarnedLuna },
      activity,
    };
  }

  const profilePicked = pickRecord(profileRaw, PROFILE_KEYS);
  if (!profilePicked) return null;
  const walletAddress = str(profilePicked.walletAddress);
  const displayName = profilePicked.displayName === null ? null : str(profilePicked.displayName);
  const handle = profilePicked.handle === null ? null : str(profilePicked.handle);
  const verifiedAt = str(profilePicked.verifiedAt);
  const joinedDate = str(profilePicked.joinedDate);
  if (walletAddress === null || displayName === undefined ||
      handle === undefined || verifiedAt === null || joinedDate === null) {
    return null;
  }

  return {
    profile: { walletAddress, displayName, handle, verifiedAt, joinedDate },
    stats: { pollsCreated, participations, nimSupportedLuna, nimEarnedLuna },
    activity,
  };
}
