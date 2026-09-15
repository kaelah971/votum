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
  loadRewardSettlementContext as loadSettlementRoot,
  resolvePollRewardSettlement as resolvePollSettlementRoot,
} from "@/lib/rewards/settlement-root";
import {
  createDefaultPayoutReconciliationDependencies,
  loadPayoutReconciliationContext,
  reconcilePayoutAttempt,
  type PayoutContextLoadResult,
  type PayoutReconciliationExecutionResult,
} from "@/lib/rewards/payout-reconciliation";
import type { RewardSettlementContext } from "@/lib/rewards/participation";
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

function safeNetworkId(): number | null {
  const value = Number(process.env.NIMIQ_NETWORK_ID);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  const result = await resolvePollSettlementRoot(admin, pollId);
  if (result.kind !== "ok") return result;
  return { kind: "ok", settlementId: result.settlementId };
}

export async function loadRewardSettlementContext(
  admin: AdminClient,
  settlementId: string,
): Promise<SettlementContextLoadResult> {
  const rootResult = await loadSettlementRoot(admin, settlementId);
  if (rootResult.kind === "not_found") return rootResult;
  if (rootResult.kind === "error") {
    return {
      kind: "error",
      reasonCode: rootResult.reasonCode === "database_read_failed"
        ? "database_read_failed"
        : "malformed_settlement_context",
    };
  }
  const root = rootResult.root;

  const { data: vault, error: vaultError } = await admin
    .from("reward_campaign_vaults")
    .select("settlement_id, vault_address_hex")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (vaultError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!vault) return { kind: "not_found", reasonCode: "vault_not_found" };

  const vaultAddressHex = typeof vault.vault_address_hex === "string"
    ? normalizeAddress(vault.vault_address_hex)
    : null;
  const networkId = safeNetworkId();
  if (
    !vaultAddressHex ||
    networkId === null ||
    vault.settlement_id !== settlementId
  ) {
    return { kind: "error", reasonCode: "malformed_settlement_context" };
  }

  return {
    kind: "ok",
    context: {
      settlementId: root.settlementId,
      ownerWallet: root.ownerWallet,
      fundingWallet: root.fundingWallet,
      vaultAddressHex,
      networkId,
      rewardPerParticipantLuna: root.rewardPerParticipantLuna,
      rewardPrincipalLuna: root.rewardPrincipalLuna,
      feeReserveLuna: root.feeReserveLuna,
      totalBudgetLuna: root.totalBudgetLuna,
      fundedAmountLuna: root.fundedAmountLuna,
      paidAmountLuna: root.paidAmountLuna,
      feeSpentLuna: root.feeSpentLuna,
      refundableExcessLuna: root.refundableExcessLuna,
      state: root.status,
      firstReservationAt: root.firstReservationAt,
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
  if ((result.settlement_id ?? result.campaign_id) !== settlementId) {
    return rpcError("settlement_mismatch");
  }
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
        if ((result.settlement_id ?? result.campaign_id) !== settlementId) {
          return rpcError("settlement_mismatch");
        }
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
