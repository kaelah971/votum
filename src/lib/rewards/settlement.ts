import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  createDefaultFundingConfirmationDependencies,
  loadFundingConfirmationContext,
  reconcileFundingIntent,
  type FundingConfirmationResult,
  type FundingContextLoadResult,
} from "@/lib/rewards/funding-confirmation";
import { mapFundingIntentResult, type FundingIntentResponse } from "@/lib/rewards/funding";
import {
  executeReservedRewardPayout,
  type RewardPayoutResult,
} from "@/lib/rewards/payout";
import {
  createDefaultPayoutReconciliationDependencies,
  loadPayoutReconciliationContext,
  reconcilePayoutAttempt,
  type PayoutContextLoadResult,
  type PayoutReconciliationExecutionResult,
} from "@/lib/rewards/payout-reconciliation";
import type { RewardSettlementContext } from "@/lib/rewards/participation";
import { isRewardCampaignState } from "@/lib/rewards/states";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type { RewardSettlementContext } from "@/lib/rewards/participation";

export type SafeSettlementError = {
  kind: "error";
  reasonCode: string;
  message?: string;
};

export type SettlementFundingResult =
  | { kind: "created" | "replay"; fundingIntent: FundingIntentResponse }
  | SafeSettlementError;

export type SettlementBindingResult =
  | {
      kind: "bound" | "bound_replay";
      settlementId: string;
      intentId: string;
      transactionHash: string;
    }
  | SafeSettlementError;

export type SettlementContextLoadResult =
  | { kind: "ok"; context: RewardSettlementContext }
  | { kind: "not_found"; reasonCode: "settlement_not_found" | "vault_not_found" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_settlement_context" };

export type PollSettlementResolution =
  | { kind: "ok"; settlementId: string }
  | { kind: "not_found"; reasonCode: "settlement_not_found" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_settlement_binding" };

type FundingLoadFailure = Exclude<FundingContextLoadResult, { kind: "ok" }>;
type PayoutLoadFailure = Exclude<PayoutContextLoadResult, { kind: "ok" }>;

export interface RewardSettlementService {
  beginFunding(settlementId: string, funderWallet: string): Promise<SettlementFundingResult>;
  bindFunding(
    settlementId: string,
    intentId: string,
    funderWallet: string,
    transactionHash: string,
  ): Promise<SettlementBindingResult>;
  confirmFunding(
    settlementId: string,
    intentId: string,
    funderWallet: string,
  ): Promise<FundingConfirmationResult | FundingLoadFailure>;
  executePayout(settlementId: string, receiptId: string): Promise<RewardPayoutResult>;
  reconcilePayout(
    settlementId: string,
    attemptId: string,
    viewerWallet: string,
  ): Promise<PayoutReconciliationExecutionResult | PayoutLoadFailure>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integerLuna(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function safeNetworkId(): number | null {
  const value = Number(process.env.NIMIQ_NETWORK_ID);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined || typeof value === "string") return value;
  return value === null ? null : undefined;
}

function rpcError(reasonCode: string, message?: string): SafeSettlementError {
  return message === undefined
    ? { kind: "error", reasonCode }
    : { kind: "error", reasonCode, message };
}

export async function resolvePollRewardSettlement(
  admin: AdminClient,
  pollId: string,
): Promise<PollSettlementResolution> {
  const { data, error } = await admin
    .from("reward_campaigns")
    .select("id, poll_id")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (error) return { kind: "error", reasonCode: "database_read_failed" };
  if (!data) return { kind: "not_found", reasonCode: "settlement_not_found" };
  if (typeof data.id !== "string" || typeof data.poll_id !== "string" || data.poll_id !== pollId) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }
  return { kind: "ok", settlementId: data.id };
}

export async function loadRewardSettlementContext(
  admin: AdminClient,
  settlementId: string,
): Promise<SettlementContextLoadResult> {
  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select(
      "id, creator_wallet, funding_wallet, reward_per_participant_luna, reward_principal_luna, fee_reserve_luna, total_budget_luna, funded_amount_luna, paid_amount_luna, fee_spent_luna, refundable_excess_luna, status, first_reservation_at",
    )
    .eq("id", settlementId)
    .maybeSingle();
  if (campaignError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!campaign) return { kind: "not_found", reasonCode: "settlement_not_found" };

  const { data: vault, error: vaultError } = await admin
    .from("reward_campaign_vaults")
    .select("campaign_id, vault_address_hex")
    .eq("campaign_id", settlementId)
    .maybeSingle();
  if (vaultError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!vault) return { kind: "not_found", reasonCode: "vault_not_found" };

  const ownerWallet = typeof campaign.creator_wallet === "string"
    ? normalizeAddress(campaign.creator_wallet)
    : null;
  const fundingWallet = typeof campaign.funding_wallet === "string"
    ? normalizeAddress(campaign.funding_wallet)
    : null;
  const vaultAddressHex = typeof vault.vault_address_hex === "string"
    ? normalizeAddress(vault.vault_address_hex)
    : null;
  const networkId = safeNetworkId();
  const rewardPerParticipantLuna = integerLuna(campaign.reward_per_participant_luna);
  const rewardPrincipalLuna = integerLuna(campaign.reward_principal_luna);
  const feeReserveLuna = integerLuna(campaign.fee_reserve_luna);
  const totalBudgetLuna = integerLuna(campaign.total_budget_luna);
  const fundedAmountLuna = integerLuna(campaign.funded_amount_luna);
  const paidAmountLuna = integerLuna(campaign.paid_amount_luna);
  const feeSpentLuna = integerLuna(campaign.fee_spent_luna);
  const refundableExcessLuna = integerLuna(campaign.refundable_excess_luna);
  const firstReservationAt = safeStringOrNull(campaign.first_reservation_at);
  if (
    campaign.id !== settlementId ||
    vault.campaign_id !== settlementId ||
    !ownerWallet ||
    !fundingWallet ||
    !vaultAddressHex ||
    networkId === null ||
    rewardPerParticipantLuna === null ||
    rewardPrincipalLuna === null ||
    feeReserveLuna === null ||
    totalBudgetLuna === null ||
    fundedAmountLuna === null ||
    paidAmountLuna === null ||
    feeSpentLuna === null ||
    refundableExcessLuna === null ||
    !isRewardCampaignState(campaign.status) ||
    firstReservationAt === undefined
  ) {
    return { kind: "error", reasonCode: "malformed_settlement_context" };
  }

  return {
    kind: "ok",
    context: {
      settlementId: campaign.id,
      ownerWallet,
      fundingWallet,
      vaultAddressHex,
      networkId,
      rewardPerParticipantLuna,
      rewardPrincipalLuna,
      feeReserveLuna,
      totalBudgetLuna,
      fundedAmountLuna,
      paidAmountLuna,
      feeSpentLuna,
      refundableExcessLuna,
      state: campaign.status,
      firstReservationAt,
    },
  };
}

function parseFundingResult(
  raw: unknown,
  settlementId: string,
): SettlementFundingResult {
  const result = asRecord(raw);
  if (!result) return rpcError("funding_intent_failed");
  const resultKind = typeof result.result_kind === "string" ? result.result_kind : "";
  if (resultKind !== "created" && resultKind !== "replay") {
    return rpcError(resultKind || "funding_intent_failed");
  }
  if (result.campaign_id !== settlementId) return rpcError("settlement_mismatch");
  const fundingIntent = mapFundingIntentResult(result);
  return fundingIntent
    ? { kind: resultKind, fundingIntent }
    : rpcError("malformed_funding_intent");
}

export function createRewardSettlementService(
  admin: AdminClient,
): RewardSettlementService {
  return {
    async beginFunding(settlementId, funderWallet) {
      try {
        const { data, error } = await admin.rpc("begin_reward_funding_atomic", {
          _campaign_id: settlementId,
          _funder_wallet: funderWallet,
        });
        if (error) return rpcError("funding_intent_failed");
        return parseFundingResult(data, settlementId);
      } catch {
        return rpcError("funding_intent_failed");
      }
    },
    async bindFunding(settlementId, intentId, funderWallet, transactionHash) {
      const normalizedHash = transactionHash.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedHash)) return rpcError("invalid_hash");
      try {
        const { data, error } = await admin.rpc("bind_reward_funding_transaction_atomic", {
          _campaign_id: settlementId,
          _intent_id: intentId,
          _funder_wallet: funderWallet,
          _transaction_hash: normalizedHash,
        });
        if (error) return rpcError("binding_failed");
        const result = asRecord(data);
        if (!result) return rpcError("binding_failed");
        const resultKind = typeof result.result_kind === "string" ? result.result_kind : "";
        if (resultKind !== "bound" && resultKind !== "bound_replay") return rpcError(resultKind || "binding_failed");
        if (result.campaign_id !== settlementId) return rpcError("settlement_mismatch");
        return {
          kind: resultKind,
          settlementId,
          intentId,
          transactionHash: normalizedHash,
        };
      } catch {
        return rpcError("binding_failed");
      }
    },
    async confirmFunding(settlementId, intentId, funderWallet) {
      const loaded = await loadFundingConfirmationContext(admin, settlementId, intentId, funderWallet);
      if (loaded.kind !== "ok") return loaded;
      return reconcileFundingIntent(
        loaded.context,
        createDefaultFundingConfirmationDependencies(admin),
      );
    },
    executePayout(settlementId, receiptId) {
      return executeReservedRewardPayout(admin, receiptId, settlementId);
    },
    async reconcilePayout(settlementId, attemptId, viewerWallet) {
      const loaded = await loadPayoutReconciliationContext(admin, settlementId, attemptId, viewerWallet);
      if (loaded.kind !== "ok") return loaded;
      return reconcilePayoutAttempt(
        loaded.context,
        createDefaultPayoutReconciliationDependencies(admin),
      );
    },
  };
}
