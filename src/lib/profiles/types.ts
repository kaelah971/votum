/**
 * V2B.1 public participant profile contracts.
 *
 * These types ARE the public allowlist: any response served about a
 * participant profile may only contain these fields. Auth/session internals,
 * vote choices, and non-public records have no representation here.
 */

/** Immutable identity anchor + optional presentation fields. */
export interface ParticipantProfile {
  /** Canonical hex Nimiq wallet address (immutable identity). */
  walletAddress: string;
  /** Optional editable display name. */
  displayName: string | null;
  /** Optional globally-unique lowercase handle. */
  handle: string | null;
  /** ISO timestamp of first successful ownership verification. */
  verifiedAt: string;
  /** ISO timestamp the profile was created (joined date). */
  joinedDate: string;
}

/**
 * Derived stats — never persisted. All values are computed at read time from
 * the authoritative polls / poll_votes / nim_contributions records.
 */
export interface ProfileStats {
  /** Public polls (is_public + live/closed) created by the wallet. */
  pollsCreated: number;
  /** Votes the wallet cast in public polls. */
  participations: number;
  /** Confirmed legacy NIM support (luna, bigint as text) — contributions only. */
  nimSupportedLuna: string;
  /** Truthful 0 until the V2B reward settlement ledger exists. */
  nimEarnedLuna: string;
}

export type ActivityKind = "created" | "participated";

/**
 * One public-safe recent activity item.
 *
 * PRIVACY INVARIANT: `question` is the only poll content ever exposed. The
 * selected option (option_id / label) is structurally absent.
 */
export interface RecentActivityItem {
  kind: ActivityKind;
  pollId: string;
  question: string;
  at: string;
}

/** Full public profile payload (profile + derived stats + recent activity). */
export interface ParticipantPublicProfile {
  /** null when the wallet/handle has no profile. */
  profile: ParticipantProfile | null;
  stats: ProfileStats;
  activity: RecentActivityItem[];
}
