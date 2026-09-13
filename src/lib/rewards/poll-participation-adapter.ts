import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseRewardParticipationContext,
  type RewardParticipationAdapter,
  type RewardParticipationContext,
} from "@/lib/rewards/participation";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface PollRewardParticipationRequest {
  pollId: string;
  participationId: string;
  verifiedSession: {
    address: string;
  };
}

export interface PollRewardParticipationStore {
  loadVote(voteId: string): Promise<{
    id: string;
    pollId: string;
    participantWallet: string;
    committed: boolean;
  } | null>;
  loadPoll(pollId: string): Promise<{
    id: string;
    creatorWallet: string;
    economicModel: string | null;
    rewardMode: string | null;
    isPublic: boolean;
    status: string;
  } | null>;
  loadSettlementBinding(pollId: string): Promise<{
    settlementId: string;
    pollId: string;
  } | null>;
}

export type PollRewardParticipationIneligibleReasonCode =
  | "invalid_request"
  | "participation_not_found"
  | "invalid_participation"
  | "participation_poll_mismatch"
  | "session_wallet_mismatch"
  | "poll_not_found"
  | "invalid_poll"
  | "poll_not_public"
  | "poll_not_rewarded"
  | "creator_not_reward_eligible"
  | "settlement_binding_missing"
  | "settlement_binding_mismatch"
  | "source_resolution_failed";

type PollParticipationResolution = Awaited<
  ReturnType<RewardParticipationAdapter<PollRewardParticipationRequest>["resolveParticipation"]>
>;

const REQUEST_KEYS = ["pollId", "participationId", "verifiedSession"] as const;
const SESSION_KEYS = ["address"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends readonly string[]>(
  value: Record<string, unknown>,
  keys: T,
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ineligible(
  reasonCode: PollRewardParticipationIneligibleReasonCode,
  sourceId?: string,
): PollParticipationResolution {
  return sourceId === undefined
    ? { kind: "ineligible", reasonCode }
    : { kind: "ineligible", reasonCode, sourceId };
}

function validRequest(value: unknown): value is PollRewardParticipationRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return false;
  if (!isNonEmptyString(value.pollId) || !isNonEmptyString(value.participationId)) return false;
  if (!isRecord(value.verifiedSession) || !hasExactKeys(value.verifiedSession, SESSION_KEYS)) return false;
  return isNonEmptyString(value.verifiedSession.address);
}

function validVote(value: unknown): value is Awaited<ReturnType<PollRewardParticipationStore["loadVote"]>> & object {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.pollId) &&
    isNonEmptyString(value.participantWallet) &&
    typeof value.committed === "boolean"
  );
}

function validPoll(value: unknown): value is Awaited<ReturnType<PollRewardParticipationStore["loadPoll"]>> & object {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.creatorWallet) &&
    (value.economicModel === null || typeof value.economicModel === "string") &&
    (value.rewardMode === null || typeof value.rewardMode === "string") &&
    typeof value.isPublic === "boolean" &&
    isNonEmptyString(value.status)
  );
}

function validSettlementBinding(
  value: unknown,
): value is Awaited<ReturnType<PollRewardParticipationStore["loadSettlementBinding"]>> & object {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.settlementId) && isNonEmptyString(value.pollId);
}

function buildContext(input: {
  voteId: string;
  participantWallet: string;
  ownerWallet: string;
  settlementId: string;
  pollId: string;
}): RewardParticipationContext | null {
  return parseRewardParticipationContext({
    source: {
      type: "poll_vote",
      id: input.voteId,
    },
    participantWallet: input.participantWallet,
    ownerWallet: input.ownerWallet,
    eligibility: {
      evidenceId: input.voteId,
      evidenceKind: "verified_wallet_vote",
      verifiedAt: new Date().toISOString(),
    },
    settlement: {
      id: input.settlementId,
      binding: {
        sourceType: "poll_vote",
        sourceId: input.pollId,
      },
    },
  });
}

export function createPollRewardParticipationAdapter(
  store: PollRewardParticipationStore,
): RewardParticipationAdapter<PollRewardParticipationRequest> {
  return {
    async resolveParticipation(request): Promise<PollParticipationResolution> {
      if (!validRequest(request)) return ineligible("invalid_request");

      let voteRaw: Awaited<ReturnType<PollRewardParticipationStore["loadVote"]>>;
      try {
        voteRaw = await store.loadVote(request.participationId);
      } catch {
        return ineligible("source_resolution_failed", request.participationId);
      }
      if (!voteRaw) return ineligible("participation_not_found", request.participationId);
      if (!validVote(voteRaw) || voteRaw.id !== request.participationId || !voteRaw.committed) {
        return ineligible("invalid_participation", request.participationId);
      }
      if (voteRaw.pollId !== request.pollId) {
        return ineligible("participation_poll_mismatch", request.participationId);
      }

      const participantWallet = normalizeAddress(voteRaw.participantWallet);
      const sessionWallet = normalizeAddress(request.verifiedSession.address);
      if (!participantWallet || !sessionWallet) {
        return ineligible("invalid_participation", request.participationId);
      }
      if (participantWallet !== sessionWallet) {
        return ineligible("session_wallet_mismatch", request.participationId);
      }

      let pollRaw: Awaited<ReturnType<PollRewardParticipationStore["loadPoll"]>>;
      try {
        pollRaw = await store.loadPoll(request.pollId);
      } catch {
        return ineligible("source_resolution_failed", request.participationId);
      }
      if (!pollRaw) return ineligible("poll_not_found", request.participationId);
      if (!validPoll(pollRaw) || pollRaw.id !== request.pollId) {
        return ineligible("invalid_poll", request.participationId);
      }
      if (!pollRaw.isPublic || (pollRaw.status !== "live" && pollRaw.status !== "closed")) {
        return ineligible("poll_not_public", request.participationId);
      }
      if (pollRaw.economicModel !== "reward_first" || pollRaw.rewardMode !== "rewarded") {
        return ineligible("poll_not_rewarded", request.participationId);
      }

      const ownerWallet = normalizeAddress(pollRaw.creatorWallet);
      if (!ownerWallet) return ineligible("invalid_poll", request.participationId);
      if (participantWallet === ownerWallet) {
        return ineligible("creator_not_reward_eligible", request.participationId);
      }

      let bindingRaw: Awaited<ReturnType<PollRewardParticipationStore["loadSettlementBinding"]>>;
      try {
        bindingRaw = await store.loadSettlementBinding(request.pollId);
      } catch {
        return ineligible("source_resolution_failed", request.participationId);
      }
      if (!bindingRaw) return ineligible("settlement_binding_missing", request.participationId);
      if (!validSettlementBinding(bindingRaw) || bindingRaw.pollId !== request.pollId) {
        return ineligible("settlement_binding_mismatch", request.participationId);
      }

      const context = buildContext({
        voteId: voteRaw.id,
        participantWallet,
        ownerWallet,
        settlementId: bindingRaw.settlementId,
        pollId: bindingRaw.pollId,
      });
      return context === null
        ? ineligible("invalid_participation", request.participationId)
        : { kind: "eligible", context };
    },
  };
}

export function createSupabasePollRewardParticipationStore(
  admin: AdminClient,
): PollRewardParticipationStore {
  return {
    loadVote: async (voteId) => {
      const { data, error } = await admin
        .from("poll_votes")
        .select("id, poll_id, voter_wallet")
        .eq("id", voteId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        pollId: data.poll_id,
        participantWallet: data.voter_wallet,
        committed: true,
      };
    },
    loadPoll: async (pollId) => {
      const { data, error } = await admin
        .from("polls")
        .select("id, creator_wallet, economic_model, reward_mode, is_public, status")
        .eq("id", pollId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        creatorWallet: data.creator_wallet,
        economicModel: data.economic_model,
        rewardMode: data.reward_mode,
        isPublic: data.is_public,
        status: data.status,
      };
    },
    loadSettlementBinding: async (pollId) => {
      const { data, error } = await admin
        .from("reward_campaigns")
        .select("id, poll_id")
        .eq("poll_id", pollId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        settlementId: data.id,
        pollId: data.poll_id,
      };
    },
  };
}
