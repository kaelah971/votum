import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  parseRewardParticipationContext,
  type RewardParticipationAdapter,
  type RewardParticipationContext,
} from "@/lib/rewards/participation";

export interface CampaignRewardParticipationRequest {
  campaignId: string;
  challengeId: string;
  verifiedSession: {
    address: string;
  };
}

export interface CampaignRewardParticipationStore {
  loadCampaign(campaignId: string): Promise<{
    id: string;
    campaignType: string;
    status: string;
    ownerWallet: string;
    startsAt: string | null;
    endsAt: string | null;
  } | null>;
  loadSettlementBinding(campaignId: string): Promise<{
    settlementId: string;
    campaignId: string;
  } | null>;
  loadChallenge(challengeId: string): Promise<{
    id: string;
    campaignId: string;
    participantWallet: string;
    consumed: boolean;
  } | null>;
}

export type CampaignRewardParticipationIneligibleReasonCode =
  | "invalid_request"
  | "campaign_not_found"
  | "unsupported_type"
  | "campaign_not_published"
  | "session_wallet_mismatch"
  | "challenge_wallet_mismatch"
  | "challenge_campaign_mismatch"
  | "creator_not_reward_eligible"
  | "settlement_binding_missing"
  | "settlement_binding_mismatch"
  | "source_resolution_failed";

type CampaignParticipationResolution = Awaited<
  ReturnType<RewardParticipationAdapter<CampaignRewardParticipationRequest>["resolveParticipation"]>
>;

const REQUEST_KEYS = ["campaignId", "challengeId", "verifiedSession"] as const;
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
  reasonCode: CampaignRewardParticipationIneligibleReasonCode,
  sourceId?: string,
): CampaignParticipationResolution {
  return sourceId === undefined
    ? { kind: "ineligible", reasonCode }
    : { kind: "ineligible", reasonCode, sourceId };
}

function validRequest(value: unknown): value is CampaignRewardParticipationRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return false;
  if (!isNonEmptyString(value.campaignId) || !isNonEmptyString(value.challengeId)) return false;
  if (!isRecord(value.verifiedSession) || !hasExactKeys(value.verifiedSession, SESSION_KEYS)) return false;
  return isNonEmptyString(value.verifiedSession.address);
}

function buildContext(input: {
  challengeId: string;
  participantWallet: string;
  ownerWallet: string;
  settlementId: string;
  campaignId: string;
}): RewardParticipationContext | null {
  return parseRewardParticipationContext({
    source: {
      type: "campaign_claim",
      id: input.challengeId,
    },
    participantWallet: input.participantWallet,
    ownerWallet: input.ownerWallet,
    eligibility: {
      evidenceId: input.challengeId,
      evidenceKind: "verified_wallet_claim",
      verifiedAt: new Date().toISOString(),
    },
    settlement: {
      id: input.settlementId,
      binding: {
        sourceType: "campaign_claim",
        sourceId: input.campaignId,
      },
    },
  });
}

/**
 * Courtesy-only participation screen for Public Giveaway claims. Resolves
 * identity (Campaign, session wallet, challenge binding, settlement) without
 * carrying amount, capacity, vault, or lifecycle data, and without deciding
 * anything the atomic claim transaction must recheck: window, closure,
 * funding readiness, capacity, and challenge expiry/consumption under lock
 * all belong to claim_campaign_reward_atomic.
 *
 * A consumed challenge is deliberately NOT rejected here. M3 performs the
 * receipt replay lookup before its consumed_at rejection, so an
 * already-consumed challenge must still reach the RPC: an exact retry
 * replays the existing receipt, while a consumed challenge with no
 * reservation fails closed as challenge_consumed. Only the RPC can make
 * that distinction.
 */
export function createCampaignRewardParticipationAdapter(
  store: CampaignRewardParticipationStore,
): RewardParticipationAdapter<CampaignRewardParticipationRequest> {
  return {
    async resolveParticipation(request): Promise<CampaignParticipationResolution> {
      if (!validRequest(request)) return ineligible("invalid_request");

      let campaignRaw: Awaited<ReturnType<CampaignRewardParticipationStore["loadCampaign"]>>;
      try {
        campaignRaw = await store.loadCampaign(request.campaignId);
      } catch {
        return ineligible("source_resolution_failed", request.campaignId);
      }
      if (!campaignRaw) return ineligible("campaign_not_found", request.campaignId);
      if (!isNonEmptyString(campaignRaw.id) || campaignRaw.id !== request.campaignId) {
        return ineligible("campaign_not_found", request.campaignId);
      }
      if (campaignRaw.campaignType !== "public_giveaway") {
        return ineligible("unsupported_type", request.campaignId);
      }
      if (campaignRaw.status !== "published") {
        return ineligible("campaign_not_published", request.campaignId);
      }

      let challengeRaw: Awaited<ReturnType<CampaignRewardParticipationStore["loadChallenge"]>>;
      try {
        challengeRaw = await store.loadChallenge(request.challengeId);
      } catch {
        return ineligible("source_resolution_failed", request.challengeId);
      }
      if (!challengeRaw) return ineligible("challenge_campaign_mismatch", request.challengeId);
      if (!isNonEmptyString(challengeRaw.id) || challengeRaw.id !== request.challengeId) {
        return ineligible("challenge_campaign_mismatch", request.challengeId);
      }
      if (challengeRaw.campaignId !== request.campaignId) {
        return ineligible("challenge_campaign_mismatch", request.challengeId);
      }

      const participantWallet = normalizeAddress(challengeRaw.participantWallet);
      const sessionWallet = normalizeAddress(request.verifiedSession.address);
      if (!sessionWallet) {
        return ineligible("invalid_request", request.challengeId);
      }
      if (!participantWallet) {
        return ineligible("challenge_wallet_mismatch", request.challengeId);
      }
      if (participantWallet !== sessionWallet) {
        return ineligible("session_wallet_mismatch", request.challengeId);
      }

      const ownerWallet = normalizeAddress(campaignRaw.ownerWallet);
      if (!ownerWallet) return ineligible("campaign_not_found", request.campaignId);
      if (participantWallet === ownerWallet) {
        return ineligible("creator_not_reward_eligible", request.challengeId);
      }

      let bindingRaw: Awaited<ReturnType<CampaignRewardParticipationStore["loadSettlementBinding"]>>;
      try {
        bindingRaw = await store.loadSettlementBinding(request.campaignId);
      } catch {
        return ineligible("source_resolution_failed", request.challengeId);
      }
      if (!bindingRaw) return ineligible("settlement_binding_missing", request.challengeId);
      if (
        !isNonEmptyString(bindingRaw.settlementId) ||
        !isNonEmptyString(bindingRaw.campaignId) ||
        bindingRaw.campaignId !== request.campaignId
      ) {
        return ineligible("settlement_binding_mismatch", request.challengeId);
      }

      const context = buildContext({
        challengeId: request.challengeId,
        participantWallet,
        ownerWallet,
        settlementId: bindingRaw.settlementId,
        campaignId: bindingRaw.campaignId,
      });
      return context === null
        ? ineligible("invalid_request", request.challengeId)
        : { kind: "eligible", context };
    },
  };
}
