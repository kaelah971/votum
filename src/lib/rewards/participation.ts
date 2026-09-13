import "server-only";

import type { RewardCampaignState } from "@/lib/rewards/states";

export type RewardParticipationSourceType = "poll_vote" | "campaign_claim";

export interface RewardParticipationContext {
  source: {
    type: RewardParticipationSourceType;
    id: string;
  };
  participantWallet: string;
  ownerWallet: string;
  eligibility: {
    evidenceId: string;
    evidenceKind: "verified_wallet_vote" | "verified_wallet_claim";
    verifiedAt: string;
  };
  settlement: {
    id: string;
    binding: {
      sourceType: RewardParticipationSourceType;
      sourceId: string;
    };
  };
}

export interface RewardParticipationAdapter<TRequest> {
  resolveParticipation(
    request: TRequest,
  ): Promise<
    | { kind: "eligible"; context: RewardParticipationContext }
    | { kind: "ineligible"; reasonCode: string; sourceId?: string }
  >;
}

export type RewardReservationResult =
  | {
      kind: "reserved" | "replay";
      settlementId: string;
      receiptId: string;
      receiptStatus: "eligible" | "reserved" | "payout_pending" | "paid" | "failed" | "retryable";
    }
  | {
      kind: "ineligible" | "rejected";
      reasonCode: string;
      sourceId?: string;
      settlementId?: string;
    };

export interface RewardSettlementContext {
  settlementId: string;
  ownerWallet: string;
  fundingWallet: string;
  vaultAddressHex: string;
  networkId: number;
  rewardPerParticipantLuna: bigint;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
  fundedAmountLuna: bigint;
  paidAmountLuna: bigint;
  feeSpentLuna: bigint;
  refundableExcessLuna: bigint;
  state: RewardCampaignState;
  firstReservationAt: string | null;
}

export interface RewardClosureTrigger {
  source: {
    type: RewardParticipationSourceType;
    id: string;
  };
  settlement: {
    id: string;
    binding: {
      sourceType: RewardParticipationSourceType;
      sourceId: string;
    };
  };
  reason: "source_closed" | "elapsed" | "expired" | "creator_cancelled" | "source_specific";
  observedAt: string;
}

export interface RewardClosureContext {
  trigger: RewardClosureTrigger;
}

export interface RewardReservationService {
  reserve(context: RewardParticipationContext): Promise<RewardReservationResult>;
}

export interface RewardSettlementService {
  executePayout(settlementId: string, receiptId: string): Promise<unknown>;
  reconcilePayout(settlementId: string, attemptId: string): Promise<unknown>;
}

export interface RewardClosureAuthorization {
  sessionTokenHash: string;
}

export interface RewardClosureService {
  prepareRefund(
    context: RewardClosureContext,
    authorization: RewardClosureAuthorization,
  ): Promise<unknown>;
  executeRefund(settlementId: string, refundId: string): Promise<unknown>;
}

const PARTICIPATION_KEYS = [
  "source",
  "participantWallet",
  "ownerWallet",
  "eligibility",
  "settlement",
] as const;
const SOURCE_KEYS = ["type", "id"] as const;
const ELIGIBILITY_KEYS = ["evidenceId", "evidenceKind", "verifiedAt"] as const;
const SETTLEMENT_KEYS = ["id", "binding"] as const;
const BINDING_KEYS = ["sourceType", "sourceId"] as const;

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceType(value: unknown): value is RewardParticipationSourceType {
  return value === "poll_vote" || value === "campaign_claim";
}

function isEvidenceKind(value: unknown): value is RewardParticipationContext["eligibility"]["evidenceKind"] {
  return value === "verified_wallet_vote" || value === "verified_wallet_claim";
}

/**
 * Validate the shape of a server-only handoff without making it a security
 * authority. Financial services must still reload their authoritative rows.
 */
export function parseRewardParticipationContext(
  value: unknown,
): RewardParticipationContext | null {
  if (!isRecord(value) || !hasExactKeys(value, PARTICIPATION_KEYS)) return null;

  const source = value.source;
  const eligibility = value.eligibility;
  const settlement = value.settlement;
  if (!isRecord(source) || !hasExactKeys(source, SOURCE_KEYS)) return null;
  if (!isRecord(eligibility) || !hasExactKeys(eligibility, ELIGIBILITY_KEYS)) return null;
  if (!isRecord(settlement) || !hasExactKeys(settlement, SETTLEMENT_KEYS)) return null;

  const binding = settlement.binding;
  if (!isRecord(binding) || !hasExactKeys(binding, BINDING_KEYS)) return null;
  if (
    !isSourceType(source.type) ||
    !nonEmptyString(source.id) ||
    !nonEmptyString(value.participantWallet) ||
    !nonEmptyString(value.ownerWallet) ||
    !nonEmptyString(eligibility.evidenceId) ||
    !isEvidenceKind(eligibility.evidenceKind) ||
    !nonEmptyString(eligibility.verifiedAt) ||
    !nonEmptyString(settlement.id) ||
    !isSourceType(binding.sourceType) ||
    !nonEmptyString(binding.sourceId)
  ) {
    return null;
  }

  const expectedEvidenceKind = source.type === "poll_vote"
    ? "verified_wallet_vote"
    : "verified_wallet_claim";
  if (
    eligibility.evidenceKind !== expectedEvidenceKind ||
    binding.sourceType !== source.type
  ) {
    return null;
  }

  return {
    source: {
      type: source.type,
      id: source.id,
    },
    participantWallet: value.participantWallet,
    ownerWallet: value.ownerWallet,
    eligibility: {
      evidenceId: eligibility.evidenceId,
      evidenceKind: eligibility.evidenceKind,
      verifiedAt: eligibility.verifiedAt,
    },
    settlement: {
      id: settlement.id,
      binding: {
        sourceType: binding.sourceType,
        sourceId: binding.sourceId,
      },
    },
  };
}
