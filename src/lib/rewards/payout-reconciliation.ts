import "server-only";

import { randomUUID } from "node:crypto";
import { createNimiqTransactionObservationAdapter } from "@/lib/nimiq/observation";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  reconcileRewardPayout,
  type FundingObservation,
  type PayoutReconciliationResult,
} from "@/lib/rewards/reconciliation";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;
type AttemptStatus = "pending" | "confirmed" | "failed" | "retryable";
type ReceiptStatus = "reserved" | "payout_pending" | "paid" | "failed" | "retryable";

export interface PayoutReconciliationContext {
  attemptId: string;
  receiptId: string;
  campaignId: string;
  attemptStatus: AttemptStatus;
  receiptStatus: ReceiptStatus;
  participantWallet: string;
  amountLuna: bigint;
  vaultAddress: string;
  networkId: number;
  transactionHash: string | null;
  broadcastStartedAt: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  paidAt: string | null;
}

export type PayoutContextLoadResult =
  | { kind: "ok"; context: PayoutReconciliationContext }
  | { kind: "not_found"; reasonCode: "attempt_not_found" | "receipt_not_found" | "campaign_not_found" | "vault_not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_payout_context" };

export interface AtomicPayoutConfirmationInput {
  attemptId: string;
  receiptId: string;
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

export type AtomicPayoutConfirmation =
  | { kind: "confirmed"; data: Record<string, unknown> }
  | { kind: "replay"; data: Record<string, unknown> }
  | { kind: "error"; code: string; message?: string };

export interface PayoutReconciliationDependencies {
  observePayoutByHash: (hash: string) => Promise<FundingObservation>;
  confirmAtomic: (input: AtomicPayoutConfirmationInput) => Promise<AtomicPayoutConfirmation>;
  createLockToken: () => string;
  acquireVaultLock: (campaignId: string, attemptId: string, token: string) => Promise<boolean>;
  releaseVaultLock: (campaignId: string, token: string) => Promise<void>;
}

export type PayoutReconciliationExecutionResult =
  | {
      kind: "confirmed";
      decision: PayoutReconciliationResult;
      atomic: AtomicPayoutConfirmation;
    }
  | {
      kind: "replay";
      attemptId: string;
      transactionHash: string | null;
    }
  | { kind: "reconciled"; decision: PayoutReconciliationResult }
  | { kind: "not_confirmable"; reasonCode: string }
  | { kind: "busy"; attemptId: string; reasonCode: "vault_busy" }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseAttemptStatus(value: unknown): AttemptStatus | null {
  return value === "pending" || value === "confirmed" || value === "failed" || value === "retryable"
    ? value
    : null;
}

function parseReceiptStatus(value: unknown): ReceiptStatus | null {
  return value === "reserved" || value === "payout_pending" || value === "paid" || value === "failed" || value === "retryable"
    ? value
    : null;
}

function safeDbNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("payout_amount_unsafe");
  return number;
}

export async function loadPayoutReconciliationContext(
  admin: AdminClient,
  pollId: string,
  attemptId: string,
  viewerWallet?: string,
): Promise<PayoutContextLoadResult> {
  const { data: attempt, error: attemptError } = await admin
    .from("reward_payout_attempts")
    .select("id, receipt_id, status, transaction_hash, network_id, broadcast_started_at, broadcast_at, confirmed_at")
    .eq("id", attemptId)
    .maybeSingle();
  if (attemptError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!attempt) return { kind: "not_found", reasonCode: "attempt_not_found" };

  const { data: receipt, error: receiptError } = await admin
    .from("reward_receipts")
    .select("id, campaign_id, poll_id, participant_wallet, amount_luna, status, paid_at")
    .eq("id", attempt.receipt_id)
    .maybeSingle();
  if (receiptError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!receipt) return { kind: "not_found", reasonCode: "receipt_not_found" };

  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select("id, poll_id")
    .eq("id", receipt.campaign_id)
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

  const participantWallet = normalizeAddress(receipt.participant_wallet);
  const vaultAddress = normalizeAddress(vault.vault_address_hex);
  const amountLuna = integerLuna(receipt.amount_luna);
  const attemptStatus = parseAttemptStatus(attempt.status);
  const receiptStatus = parseReceiptStatus(receipt.status);
  if (
    receipt.poll_id !== pollId ||
    campaign.poll_id !== pollId ||
    campaign.id !== receipt.campaign_id ||
    !participantWallet ||
    !vaultAddress ||
    amountLuna === null ||
    amountLuna <= BigInt(0) ||
    !attemptStatus ||
    !receiptStatus ||
    typeof attempt.id !== "string" ||
    typeof attempt.receipt_id !== "string" ||
    typeof receipt.id !== "string" ||
    typeof receipt.campaign_id !== "string" ||
    typeof campaign.id !== "string"
  ) {
    return { kind: "error", reasonCode: "malformed_payout_context" };
  }

  if (viewerWallet !== undefined) {
    const viewer = normalizeAddress(viewerWallet);
    if (!viewer || viewer !== participantWallet) return { kind: "forbidden" };
  }

  const networkId = attempt.network_id;
  if (
    typeof networkId !== "number" ||
    !Number.isSafeInteger(networkId) ||
    networkId < 0
  ) {
    return { kind: "error", reasonCode: "malformed_payout_context" };
  }

  return {
    kind: "ok",
    context: {
      attemptId: attempt.id,
      receiptId: receipt.id,
      campaignId: campaign.id,
      attemptStatus,
      receiptStatus,
      participantWallet,
      amountLuna,
      vaultAddress,
      networkId,
      transactionHash: stringOrNull(attempt.transaction_hash),
      broadcastStartedAt: stringOrNull(attempt.broadcast_started_at),
      broadcastAt: stringOrNull(attempt.broadcast_at),
      confirmedAt: stringOrNull(attempt.confirmed_at),
      paidAt: stringOrNull(receipt.paid_at),
    },
  };
}

function toPayoutExpected(context: PayoutReconciliationContext) {
  return {
    campaignId: context.campaignId,
    receiptId: context.receiptId,
    attemptId: context.attemptId,
    networkId: context.networkId,
    transactionHash: context.transactionHash as string,
    vaultAddress: context.vaultAddress,
    participantWallet: context.participantWallet,
    amountLuna: context.amountLuna,
  };
}

export async function reconcilePayoutAttempt(
  context: PayoutReconciliationContext,
  dependencies: PayoutReconciliationDependencies,
): Promise<PayoutReconciliationExecutionResult> {
  if (context.attemptStatus === "confirmed" && context.receiptStatus === "paid") {
    return {
      kind: "replay",
      attemptId: context.attemptId,
      transactionHash: context.transactionHash,
    };
  }
  if (context.attemptStatus !== "pending" || context.receiptStatus !== "payout_pending") {
    return { kind: "not_confirmable", reasonCode: "payout_state_conflict" };
  }
  if (context.transactionHash === null) {
    return { kind: "not_confirmable", reasonCode: "missing_transaction_hash" };
  }
  if (context.broadcastStartedAt === null) {
    return { kind: "not_confirmable", reasonCode: "broadcast_not_started" };
  }

  const token = dependencies.createLockToken();
  if (!await dependencies.acquireVaultLock(context.campaignId, context.attemptId, token)) {
    return { kind: "busy", attemptId: context.attemptId, reasonCode: "vault_busy" };
  }

  try {
    const observation = await dependencies.observePayoutByHash(context.transactionHash);
    const decision = reconcileRewardPayout(toPayoutExpected(context), observation);
    if (!decision.confirmed) return { kind: "reconciled", decision };
    if (observation.kind !== "found") {
      return { kind: "error", reasonCode: "confirmed_observation_missing_block" };
    }

    const observed = observation.transaction;
    const blockNumber = observed.blockHeight;
    if (blockNumber === null) {
      return { kind: "error", reasonCode: "confirmed_observation_missing_block" };
    }
    const evidence = observed.finalityEvidence;
    const observedSender = observed.sender === null ? null : normalizeAddress(observed.sender);
    const observedRecipient = normalizeAddress(observed.recipient);
    if (
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
      attemptId: context.attemptId,
      receiptId: context.receiptId,
      campaignId: context.campaignId,
      transactionHash: observed.transactionHash.trim().toLowerCase(),
      networkId: observed.networkId as number,
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
      ? { kind: "replay", attemptId: context.attemptId, transactionHash: context.transactionHash }
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
      // Lease expiry is the second release path if the request is lost.
    }
  }
}

export function createDefaultPayoutReconciliationDependencies(
  admin: AdminClient,
): PayoutReconciliationDependencies {
  const adapter = createNimiqTransactionObservationAdapter();
  return {
    observePayoutByHash: (hash) => adapter.observeFundingByHash(hash),
    confirmAtomic: async (input) => {
      const { data, error } = await admin.rpc("confirm_reward_payout_atomic", {
        _attempt_id: input.attemptId,
        _receipt_id: input.receiptId,
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
      const result = asRecord(data);
      const resultKind = typeof result?.result_kind === "string" ? result.result_kind : "";
      if (resultKind === "confirmed") return { kind: "confirmed", data: result ?? {} };
      if (resultKind === "replay") return { kind: "replay", data: result ?? {} };
      return { kind: "error", code: resultKind || "confirmation_rejected" };
    },
    createLockToken: randomUUID,
    acquireVaultLock: async (campaignId, attemptId, token) => {
      const { data, error } = await admin.rpc("acquire_reward_payout_vault_lock_atomic", {
        _campaign_id: campaignId,
        _attempt_id: attemptId,
        _lock_token: token,
        _lease_seconds: 120,
      });
      if (error) return false;
      const result = asRecord(data);
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
