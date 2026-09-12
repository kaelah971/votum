import "server-only";

import { randomUUID } from "node:crypto";
import { createNimiqTransactionObservationAdapter } from "@/lib/nimiq/observation";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  reconcileRewardRefund,
  type ExpectedRefund,
  type FundingObservation,
  type RefundReconciliationResult,
} from "@/lib/rewards/reconciliation";
import {
  isRewardCampaignState,
  isRewardRefundState,
  type RewardCampaignState,
  type RewardRefundState,
} from "@/lib/rewards/states";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface RefundReconciliationContext {
  refundId: string;
  campaignId: string;
  campaignStatus: RewardCampaignState;
  refundStatus: RewardRefundState;
  creatorWallet: string;
  amountLuna: bigint;
  vaultAddress: string;
  networkId: number;
  transactionHash: string | null;
  broadcastStartedAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  refundedAt: string | null;
  closedAt: string | null;
}

export type RefundContextLoadResult =
  | { kind: "ok"; context: RefundReconciliationContext }
  | { kind: "not_found"; reasonCode: "refund_not_found" | "campaign_not_found" | "vault_not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_refund_context" };

export interface AtomicRefundConfirmationInput {
  refundId: string;
  campaignId: string;
  transactionHash: string;
  networkId: number;
  observedSender: string;
  observedRecipient: string;
  observedAmountLuna: bigint;
  executionResult: true;
  blockNumber: number;
  transactionTimestampMs: number | null;
  transactionBlockHash: string | null;
  canonicalBlockHash: string;
  batchNumber: number;
  finalizingMacroBlockHeight: number;
  finalizingMacroBlockHash: string;
}

export type AtomicRefundConfirmation =
  | { kind: "confirmed"; data: Record<string, unknown> }
  | { kind: "replay"; data: Record<string, unknown> }
  | { kind: "error"; code: string; message?: string };

export interface RefundReconciliationDependencies {
  observeRefundByHash: (hash: string) => Promise<FundingObservation>;
  confirmAtomic: (input: AtomicRefundConfirmationInput) => Promise<AtomicRefundConfirmation>;
  createLockToken: () => string;
  acquireVaultLock: (campaignId: string, refundId: string, token: string) => Promise<boolean>;
  releaseVaultLock: (campaignId: string, token: string) => Promise<void>;
}

export type RefundReconciliationExecutionResult =
  | {
      kind: "confirmed";
      decision: RefundReconciliationResult;
      atomic: AtomicRefundConfirmation;
    }
  | {
      kind: "replay";
      refundId: string;
      transactionHash: string | null;
    }
  | { kind: "reconciled"; decision: RefundReconciliationResult }
  | { kind: "not_confirmable"; reasonCode: string }
  | { kind: "busy"; refundId: string; reasonCode: "vault_busy" }
  | { kind: "error"; reasonCode: string; message?: string };

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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeDbNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("refund_amount_unsafe");
  return number;
}

export async function loadRefundReconciliationContext(
  admin: AdminClient,
  pollId: string,
  refundId: string,
  viewerWallet?: string,
): Promise<RefundContextLoadResult> {
  const { data: refund, error: refundError } = await admin
    .from("reward_refunds")
    .select("id, campaign_id, creator_wallet, amount_luna, status, transaction_hash, network_id, broadcast_started_at, broadcast_at, confirmed_at")
    .eq("id", refundId)
    .maybeSingle();
  if (refundError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!refund) return { kind: "not_found", reasonCode: "refund_not_found" };

  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select("id, poll_id, status, refunded_at, closed_at")
    .eq("id", refund.campaign_id)
    .maybeSingle();
  if (campaignError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!campaign) return { kind: "not_found", reasonCode: "campaign_not_found" };

  const { data: vault, error: vaultError } = await admin
    .from("reward_campaign_vaults")
    .select("vault_address_hex")
    .eq("campaign_id", campaign.id)
    .maybeSingle();
  if (vaultError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!vault) return { kind: "not_found", reasonCode: "vault_not_found" };

  const creatorWallet = normalizeAddress(refund.creator_wallet);
  const vaultAddress = normalizeAddress(vault.vault_address_hex);
  const amountLuna = integerLuna(refund.amount_luna);
  const networkId = refund.network_id;
  if (
    refund.id !== refundId ||
    refund.campaign_id !== campaign.id ||
    campaign.poll_id !== pollId ||
    !creatorWallet ||
    !vaultAddress ||
    amountLuna === null ||
    amountLuna <= BigInt(0) ||
    typeof refund.status !== "string" ||
    !isRewardRefundState(refund.status) ||
    typeof campaign.status !== "string" ||
    !isRewardCampaignState(campaign.status) ||
    typeof networkId !== "number" ||
    !Number.isSafeInteger(networkId) ||
    networkId < 0
  ) {
    return { kind: "error", reasonCode: "malformed_refund_context" };
  }

  if (viewerWallet !== undefined) {
    const viewer = normalizeAddress(viewerWallet);
    if (!viewer || viewer !== creatorWallet) return { kind: "forbidden" };
  }

  return {
    kind: "ok",
    context: {
      refundId: refund.id,
      campaignId: campaign.id,
      campaignStatus: campaign.status,
      refundStatus: refund.status,
      creatorWallet,
      amountLuna,
      vaultAddress,
      networkId,
      transactionHash: stringOrNull(refund.transaction_hash),
      broadcastStartedAt: stringOrNull(refund.broadcast_started_at),
      broadcastAt: stringOrNull(refund.broadcast_at),
      confirmedAt: stringOrNull(refund.confirmed_at),
      refundedAt: stringOrNull(campaign.refunded_at),
      closedAt: stringOrNull(campaign.closed_at),
    },
  };
}

function toExpectedRefund(context: RefundReconciliationContext): ExpectedRefund {
  return {
    campaignId: context.campaignId,
    refundId: context.refundId,
    networkId: context.networkId,
    transactionHash: context.transactionHash as string,
    vaultAddress: context.vaultAddress,
    creatorWallet: context.creatorWallet,
    amountLuna: context.amountLuna,
  };
}

export async function reconcileRefund(
  context: RefundReconciliationContext,
  dependencies: RefundReconciliationDependencies,
): Promise<RefundReconciliationExecutionResult> {
  if (context.refundStatus === "confirmed" && context.campaignStatus === "refunded") {
    return {
      kind: "replay",
      refundId: context.refundId,
      transactionHash: context.transactionHash,
    };
  }
  if (context.campaignStatus !== "refunding" || context.refundStatus !== "pending") {
    return { kind: "not_confirmable", reasonCode: "refund_state_conflict" };
  }
  if (context.transactionHash === null) {
    return { kind: "not_confirmable", reasonCode: "missing_transaction_hash" };
  }
  if (context.broadcastStartedAt === null) {
    return { kind: "not_confirmable", reasonCode: "broadcast_not_started" };
  }

  const token = dependencies.createLockToken();
  if (!await dependencies.acquireVaultLock(context.campaignId, context.refundId, token)) {
    return { kind: "busy", refundId: context.refundId, reasonCode: "vault_busy" };
  }

  try {
    const observation = await dependencies.observeRefundByHash(context.transactionHash);
    const decision = reconcileRewardRefund(toExpectedRefund(context), observation);
    if (!decision.confirmed) return { kind: "reconciled", decision };
    if (observation.kind !== "found") {
      return { kind: "error", reasonCode: "confirmed_observation_missing_block" };
    }

    const observed = observation.transaction;
    const blockNumber = observed.blockHeight;
    const evidence = observed.finalityEvidence;
    const observedSender = observed.sender === null ? null : normalizeAddress(observed.sender);
    const observedRecipient = normalizeAddress(observed.recipient);
    if (
      observed.networkId === null ||
      blockNumber === null ||
      !observedSender ||
      !observedRecipient ||
      !evidence ||
      evidence.canonicalBlockHash === null ||
      evidence.batchNumber === null ||
      evidence.finalizingMacroBlockHeight === null ||
      evidence.finalizingMacroBlockHash === null
    ) {
      return { kind: "error", reasonCode: "confirmed_observation_malformed" };
    }

    const atomic = await dependencies.confirmAtomic({
      refundId: context.refundId,
      campaignId: context.campaignId,
      transactionHash: observed.transactionHash.trim().toLowerCase(),
      networkId: observed.networkId,
      observedSender,
      observedRecipient,
      observedAmountLuna: observed.valueLuna,
      executionResult: true,
      blockNumber,
      transactionTimestampMs: observed.timestampMs,
      transactionBlockHash: observed.blockHash,
      canonicalBlockHash: evidence.canonicalBlockHash,
      batchNumber: evidence.batchNumber,
      finalizingMacroBlockHeight: evidence.finalizingMacroBlockHeight,
      finalizingMacroBlockHash: evidence.finalizingMacroBlockHash,
    });
    if (atomic.kind === "error") {
      return { kind: "error", reasonCode: "atomic_confirmation_failed", message: atomic.message };
    }
    return atomic.kind === "replay"
      ? { kind: "replay", refundId: context.refundId, transactionHash: context.transactionHash }
      : { kind: "confirmed", decision, atomic };
  } catch (error) {
    return {
      kind: "error",
      reasonCode: "reconciliation_failed",
      message: error instanceof Error ? error.message : undefined,
    };
  } finally {
    try {
      await dependencies.releaseVaultLock(context.campaignId, token);
    } catch {
      // Lease expiry is the second release path if this request is lost.
    }
  }
}

export function createDefaultRefundReconciliationDependencies(
  admin: AdminClient,
): RefundReconciliationDependencies {
  const adapter = createNimiqTransactionObservationAdapter();
  return {
    observeRefundByHash: (hash) => adapter.observeFundingByHash(hash),
    confirmAtomic: async (input) => {
      const { data, error } = await admin.rpc("confirm_reward_refund_atomic", {
        _refund_id: input.refundId,
        _campaign_id: input.campaignId,
        _transaction_hash: input.transactionHash,
        _network_id: input.networkId,
        _observed_sender: input.observedSender,
        _observed_recipient: input.observedRecipient,
        _observed_amount_luna: safeDbNumber(input.observedAmountLuna),
        _execution_result: input.executionResult,
        _block_number: input.blockNumber,
        _transaction_timestamp: input.transactionTimestampMs === null
          ? null
          : new Date(input.transactionTimestampMs).toISOString(),
        _transaction_block_hash: input.transactionBlockHash,
        _canonical_block_hash: input.canonicalBlockHash,
        _batch_number: input.batchNumber,
        _finalizing_macro_block_height: input.finalizingMacroBlockHeight,
        _finalizing_macro_block_hash: input.finalizingMacroBlockHash,
      });
      if (error) return { kind: "error", code: error.code, message: error.message };
      const result = typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
      const resultKind = typeof result?.result_kind === "string" ? result.result_kind : "";
      if (resultKind === "confirmed") return { kind: "confirmed", data: result ?? {} };
      if (resultKind === "replay") return { kind: "replay", data: result ?? {} };
      return { kind: "error", code: resultKind || "confirmation_rejected" };
    },
    createLockToken: randomUUID,
    acquireVaultLock: async (campaignId, refundId, token) => {
      const { data, error } = await admin.rpc("acquire_reward_refund_vault_lock_atomic", {
        _campaign_id: campaignId,
        _refund_id: refundId,
        _lock_token: token,
        _lease_seconds: 120,
      });
      if (error) return false;
      const result = typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
      return result?.result_kind === "acquired";
    },
    releaseVaultLock: async (campaignId, token) => {
      await admin.rpc("release_reward_payout_vault_lock_atomic", {
        _campaign_id: campaignId,
        _lock_token: token,
      });
    },
  };
}
