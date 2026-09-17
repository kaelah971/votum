import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { loadCampaignReservationAuthority } from "@/lib/campaigns/claim-participation-store";
import {
  parseRewardParticipationContext,
  type RewardParticipationContext,
  type RewardReservationResult,
  type RewardReservationService,
} from "@/lib/rewards/participation";
import { resolvePollRewardSettlement } from "@/lib/rewards/settlement-root";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface RewardReservationAuthority {
  sourceId: string;
  sourceType: "poll_vote" | "campaign_claim";
  settlementId: string;
  bindingSourceId: string;
  participantWallet: string;
  ownerWallet: string;
}

export interface RewardReservationStore {
  loadAuthority(context: RewardParticipationContext): Promise<RewardReservationAuthority | null>;
  reserveAtomic(sourceId: string, settlementId: string): Promise<unknown>;
  reserveCampaignAtomic?(input: {
    campaignId: string;
    participantWallet: string;
    challengeId: string;
  }): Promise<unknown>;
}

type ReservationSuccess = Extract<RewardReservationResult, { kind: "reserved" | "replay" }>;
type ReceiptStatus = ReservationSuccess["receiptStatus"];

const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  "eligible",
  "reserved",
  "payout_pending",
  "paid",
  "failed",
  "retryable",
];

const INELIGIBLE_RESULT_KINDS = new Set([
  "participation_not_found",
  "campaign_not_found",
  "participation_poll_mismatch",
  "poll_not_public",
  "poll_not_rewarded",
  "creator_not_reward_eligible",
  "creator_not_eligible",
  "campaign_not_funded",
  "campaign_not_reservable",
  "campaign_not_published",
  "campaign_closed",
  "unsupported_type",
  "claim_not_started",
  "claim_ended",
  "challenge_invalid",
  "challenge_expired",
  "challenge_consumed",
  "no_reward_capacity",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return typeof value === "string" && RECEIPT_STATUSES.includes(value as ReceiptStatus);
}

function sourceIdFromContext(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.source)) return undefined;
  return typeof value.source.id === "string" ? value.source.id : undefined;
}

function ineligible(
  reasonCode: string,
  sourceId: string,
): RewardReservationResult {
  return { kind: "ineligible", reasonCode, sourceId };
}

function rejected(
  reasonCode: string,
  sourceId: string,
): RewardReservationResult {
  return { kind: "rejected", reasonCode, sourceId };
}

function hasPollEvidence(context: RewardParticipationContext): boolean {
  return context.source.type === "poll_vote" &&
    context.eligibility.evidenceId === context.source.id &&
    context.eligibility.evidenceKind === "verified_wallet_vote" &&
    context.settlement.binding.sourceType === "poll_vote";
}

function hasCampaignEvidence(context: RewardParticipationContext): boolean {
  return context.source.type === "campaign_claim" &&
    context.eligibility.evidenceId === context.source.id &&
    context.eligibility.evidenceKind === "verified_wallet_claim" &&
    context.settlement.binding.sourceType === "campaign_claim";
}

function validAuthority(value: unknown): value is RewardReservationAuthority {
  if (!isRecord(value)) return false;
  return (value.sourceType === "poll_vote" || value.sourceType === "campaign_claim") &&
    isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.settlementId) &&
    isNonEmptyString(value.bindingSourceId) &&
    isNonEmptyString(value.participantWallet) &&
    isNonEmptyString(value.ownerWallet);
}

function sameCanonicalAddress(left: string, right: string): boolean {
  const leftCanonical = normalizeAddress(left);
  const rightCanonical = normalizeAddress(right);
  return leftCanonical !== null && rightCanonical !== null && leftCanonical === rightCanonical;
}

function matchesAuthority(
  context: RewardParticipationContext,
  authority: unknown,
): authority is RewardReservationAuthority {
  return validAuthority(authority) &&
    authority.sourceId === context.source.id &&
    authority.settlementId === context.settlement.id &&
    authority.bindingSourceId === context.settlement.binding.sourceId &&
    sameCanonicalAddress(authority.participantWallet, context.participantWallet) &&
    sameCanonicalAddress(authority.ownerWallet, context.ownerWallet);
}

function parseAtomicResult(
  value: unknown,
  context: RewardParticipationContext,
): RewardReservationResult {
  const sourceId = context.source.id;
  if (!isRecord(value) || typeof value.result_kind !== "string") {
    return rejected("invalid_reservation_result", sourceId);
  }

  const resultKind = value.result_kind;
  if (resultKind === "reserved" || resultKind === "replay") {
    // Existing RPC names remain part of the Poll compatibility surface while
    // settlement_id is the authoritative identity returned by cutover RPCs.
    const resultSettlementId = value.settlement_id ?? value.campaign_id;
    if (
       resultSettlementId !== context.settlement.id ||
       !isNonEmptyString(value.receipt_id) ||
       !isReceiptStatus(value.status)
    ) {
      return rejected("invalid_reservation_result", sourceId);
    }

    return {
      kind: resultKind,
      settlementId: context.settlement.id,
      receiptId: value.receipt_id,
      receiptStatus: value.status,
    };
  }

  if (INELIGIBLE_RESULT_KINDS.has(resultKind)) {
    return ineligible(resultKind, sourceId);
  }

  return rejected("unknown_reservation_result", sourceId);
}

export function createRewardReservationService(
  store: RewardReservationStore,
): RewardReservationService {
  return {
    async reserve(context): Promise<RewardReservationResult> {
      const parsedContext = parseRewardParticipationContext(context);
      const sourceId = sourceIdFromContext(context) ?? "";
      const isPoll = parsedContext !== null && hasPollEvidence(parsedContext);
      const isCampaign = parsedContext !== null && hasCampaignEvidence(parsedContext);
      if (!parsedContext || (!isPoll && !isCampaign)) {
        return sourceId ? ineligible("invalid_context", sourceId) : { kind: "ineligible", reasonCode: "invalid_context" };
      }

      let authority: RewardReservationAuthority | null;
      try {
        authority = await store.loadAuthority(parsedContext);
      } catch {
        return rejected("authority_resolution_failed", parsedContext.source.id);
      }

      if (!matchesAuthority(parsedContext, authority)) {
        return ineligible("authority_mismatch", parsedContext.source.id);
      }

      let atomicResult: unknown;
      try {
        if (isPoll) {
          atomicResult = await store.reserveAtomic(
            parsedContext.source.id,
            parsedContext.settlement.id,
          );
        } else {
          if (!store.reserveCampaignAtomic) {
            return rejected("reservation_failed", parsedContext.source.id);
          }
          atomicResult = await store.reserveCampaignAtomic({
            campaignId: parsedContext.settlement.binding.sourceId,
            participantWallet: parsedContext.participantWallet,
            challengeId: parsedContext.source.id,
          });
        }
      } catch {
        return rejected("reservation_failed", parsedContext.source.id);
      }

      return parseAtomicResult(atomicResult, parsedContext);
    },
  };
}

export function createSupabaseRewardReservationStore(
  admin: AdminClient,
): RewardReservationStore {
  return {
    async loadAuthority(context) {
      if (context.source.type === "campaign_claim") {
        return loadCampaignReservationAuthority(admin, context);
      }
      if (context.source.type !== "poll_vote") return null;

      const { data: vote, error: voteError } = await admin
        .from("poll_votes")
        .select("id, poll_id, voter_wallet")
        .eq("id", context.source.id)
        .maybeSingle();
      if (voteError || !vote) return null;

      const { data: poll, error: pollError } = await admin
        .from("polls")
        .select("id, creator_wallet")
        .eq("id", vote.poll_id)
        .maybeSingle();
      if (pollError || !poll) return null;

      const pollOwner = normalizeAddress(poll.creator_wallet);
      const binding = await resolvePollRewardSettlement(admin, vote.poll_id);
      if (binding.kind !== "ok") return null;
      const campaignOwner = binding.ownerWallet;
      if (
        poll.id !== vote.poll_id ||
        binding.pollId !== vote.poll_id ||
        binding.settlementId !== context.settlement.id ||
        pollOwner === null ||
        campaignOwner === null ||
        pollOwner !== campaignOwner
      ) {
        return null;
      }

      return {
        sourceId: vote.id,
        sourceType: "poll_vote",
        settlementId: context.settlement.id,
        bindingSourceId: binding.pollId,
        participantWallet: vote.voter_wallet,
        ownerWallet: binding.ownerWallet,
      };
    },
    async reserveAtomic(sourceId, settlementId) {
      const { data, error } = await admin.rpc("claim_reward_receipt_atomic", {
        _participation_id: sourceId,
        _campaign_id: settlementId,
      });
      if (error) throw error;
      return data;
    },
    async reserveCampaignAtomic(input) {
      const { data, error } = await admin.rpc("claim_campaign_reward_atomic", {
        _campaign_id: input.campaignId,
        _participant_wallet: input.participantWallet,
        _challenge_id: input.challengeId,
      });
      if (error) throw error;
      return data;
    },
  };
}
