import "server-only";

import { randomUUID } from "node:crypto";
import { createNimiqBroadcastAdapter } from "@/lib/nimiq/broadcast";
import {
  ESTIMATED_TX_FEE_LUNA,
} from "@/lib/rewards/constants";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
} from "@/lib/rewards/vault-signing";
import { withCampaignVaultKey } from "@/lib/rewards/vault-service";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface PayoutAttemptSnapshot {
  attemptId: string;
  receiptId: string;
  campaignId: string;
  attemptNumber: number;
  attemptStatus: "pending" | "confirmed" | "failed" | "retryable";
  receiptStatus: "reserved" | "payout_pending" | "paid" | "failed" | "retryable";
  participantWallet: string;
  amountLuna: bigint;
  vaultAddressHex: string;
  preparedTransactionHex: string | null;
  transactionHash: string | null;
  preparedFeeLuna: bigint | null;
  preparedNetworkId: number | null;
  preparedValidityStartHeight: number | null;
  preparedSenderAddressHex: string | null;
  preparedRecipientAddressHex: string | null;
  broadcastStartedAt: string | null;
  broadcastAt: string | null;
}

export type PayoutClaim =
  | { kind: "claimed" | "replay"; attempt: PayoutAttemptSnapshot }
  | { kind: "rejected"; reasonCode: string };

export interface PayoutSigningContext {
  campaignId: string;
  attemptId: string;
  senderAddressHex: string;
  recipientAddressHex: string;
  amountLuna: bigint;
  feeLuna: bigint;
  networkId: number;
  validityStartHeight: number;
}

export interface PayoutPreparedTransaction extends PayoutSigningContext {
  serializedTransactionHex: string;
  transactionHash: string;
}

export interface RewardPayoutStore {
  beginPayoutAtomic(receiptId: string, campaignId: string): Promise<PayoutClaim>;
  loadPayoutAttempt(attemptId: string): Promise<PayoutAttemptSnapshot | null>;
  acquireVaultLock(campaignId: string, attemptId: string, token: string): Promise<boolean>;
  persistPrepared(attemptId: string, prepared: PayoutPreparedTransaction): Promise<void>;
  markBroadcastStarting(attemptId: string): Promise<boolean>;
  markBroadcastSuccess(attemptId: string, transactionHash: string): Promise<void>;
  recordDefiniteFailure(attemptId: string, errorCode: string): Promise<void>;
  recordUnknownOutcome(attemptId: string, errorCode: string): Promise<void>;
  releaseVaultLock(campaignId: string, token: string): Promise<void>;
}

export type PayoutBroadcastResult =
  | { kind: "broadcast"; transactionHash: string }
  | { kind: "definitely_not_broadcast"; errorCode: string }
  | { kind: "unknown"; errorCode: string }
  | { kind: "malformed"; errorCode: string };

export interface PayoutDependencies {
  store: RewardPayoutStore;
  createLockToken: () => string;
  sign: (context: PayoutSigningContext) => Promise<PayoutPreparedTransaction>;
  broadcast: (serializedTransactionHex: string) => Promise<PayoutBroadcastResult>;
  getNetworkId: () => number;
  getValidityStartHeight: () => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
}

export type RewardPayoutResult =
  | { kind: "broadcasted"; attemptId: string; transactionHash: string }
  | { kind: "already_pending"; attemptId: string; transactionHash: string | null }
  | { kind: "unknown"; attemptId: string; transactionHash: string | null; reasonCode: string }
  | { kind: "retryable"; attemptId: string; reasonCode: string }
  | { kind: "rejected"; reasonCode: string }
  | { kind: "busy"; attemptId: string; reasonCode: "vault_busy" };

function safeNetworkId(): number {
  const value = Number(process.env.NIMIQ_NETWORK_ID);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("nimiq_network_id_invalid");
  return value;
}

function normalizeHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("transaction_hash_invalid");
  return normalized;
}

function assertPreparedMatchesContext(
  prepared: PayoutPreparedTransaction,
  context: PayoutSigningContext,
): PayoutPreparedTransaction {
  if (
    prepared.campaignId !== context.campaignId ||
    prepared.attemptId !== context.attemptId ||
    prepared.senderAddressHex.toLowerCase() !== context.senderAddressHex.toLowerCase() ||
    prepared.recipientAddressHex.toLowerCase() !== context.recipientAddressHex.toLowerCase() ||
    prepared.amountLuna !== context.amountLuna ||
    prepared.feeLuna !== context.feeLuna ||
    prepared.networkId !== context.networkId ||
    prepared.validityStartHeight !== context.validityStartHeight ||
    !/^[0-9a-fA-F]+$/.test(prepared.serializedTransactionHex) ||
    prepared.serializedTransactionHex.length % 2 !== 0
  ) {
    throw new Error("prepared_transaction_mismatch");
  }
  return {
    ...prepared,
    transactionHash: normalizeHash(prepared.transactionHash),
    serializedTransactionHex: prepared.serializedTransactionHex.toLowerCase(),
  };
}

function safeResultError(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
    ? error.message
    : "payout_preparation_failed";
}

async function acquireVaultLock(
  dependencies: PayoutDependencies,
  campaignId: string,
  attemptId: string,
): Promise<string | null> {
  const token = dependencies.createLockToken();
  for (let i = 0; i < 600; i++) {
    if (await dependencies.store.acquireVaultLock(campaignId, attemptId, token)) return token;
    await dependencies.sleep(50);
  }
  return null;
}

function attemptResult(attempt: PayoutAttemptSnapshot): RewardPayoutResult {
  return {
    kind: "already_pending",
    attemptId: attempt.attemptId,
    transactionHash: attempt.transactionHash,
  };
}

/**
 * Execute one authoritative reserved receipt. The database claim is the only
 * source of recipient/amount/campaign vault data. A prepared signed transaction
 * is persisted before the irreversible broadcast call; broadcast-start is also
 * persisted first, so an unknown response is never retried automatically.
 */
export async function runRewardPayout(
  input: { receiptId: string; campaignId: string },
  dependencies: PayoutDependencies,
): Promise<RewardPayoutResult> {
  const claim = await dependencies.store.beginPayoutAtomic(input.receiptId, input.campaignId);
  if (claim.kind === "rejected") return { kind: "rejected", reasonCode: claim.reasonCode };

  const claimedAttempt = claim.attempt;
  const token = await acquireVaultLock(
    dependencies,
    claimedAttempt.campaignId,
    claimedAttempt.attemptId,
  );
  if (token === null) {
    return { kind: "busy", attemptId: claimedAttempt.attemptId, reasonCode: "vault_busy" };
  }

  let broadcastStarted = false;
  let preparedTransactionHash: string | null = claimedAttempt.transactionHash;
  try {
    const attempt = await dependencies.store.loadPayoutAttempt(claimedAttempt.attemptId);
    if (!attempt) return { kind: "rejected", reasonCode: "attempt_not_found" };
    if (attempt.attemptStatus !== "pending" || attempt.receiptStatus !== "payout_pending") {
      return attemptResult(attempt);
    }
    if (attempt.broadcastStartedAt !== null || attempt.broadcastAt !== null) {
      return attemptResult(attempt);
    }

    const networkId = dependencies.getNetworkId();
    if (!Number.isSafeInteger(networkId) || networkId < 0) throw new Error("nimiq_network_id_invalid");

    let prepared: PayoutPreparedTransaction;
    if (attempt.preparedTransactionHex !== null || attempt.transactionHash !== null) {
      if (attempt.preparedTransactionHex === null || attempt.transactionHash === null) {
        throw new Error("prepared_transaction_incomplete");
      }
      const preparedFeeLuna = attempt.preparedFeeLuna;
      const preparedNetworkId = attempt.preparedNetworkId;
      const preparedValidityStartHeight = attempt.preparedValidityStartHeight;
      const preparedSenderAddressHex = attempt.preparedSenderAddressHex;
      const preparedRecipientAddressHex = attempt.preparedRecipientAddressHex;
      if (
        preparedFeeLuna === null ||
        preparedNetworkId === null ||
        preparedValidityStartHeight === null ||
        preparedSenderAddressHex === null ||
        preparedRecipientAddressHex === null
      ) {
        throw new Error("prepared_transaction_incomplete");
      }
      prepared = assertPreparedMatchesContext({
        campaignId: attempt.campaignId,
        attemptId: attempt.attemptId,
        senderAddressHex: preparedSenderAddressHex,
        recipientAddressHex: preparedRecipientAddressHex,
        amountLuna: attempt.amountLuna,
        feeLuna: preparedFeeLuna,
        networkId: preparedNetworkId,
        validityStartHeight: preparedValidityStartHeight,
        serializedTransactionHex: attempt.preparedTransactionHex,
        transactionHash: attempt.transactionHash,
      }, {
        campaignId: attempt.campaignId,
        attemptId: attempt.attemptId,
        senderAddressHex: attempt.vaultAddressHex,
        recipientAddressHex: attempt.participantWallet,
        amountLuna: attempt.amountLuna,
        feeLuna: preparedFeeLuna,
        networkId,
        validityStartHeight: preparedValidityStartHeight,
      });
      preparedTransactionHash = prepared.transactionHash;
    } else {
      const context: PayoutSigningContext = {
        campaignId: attempt.campaignId,
        attemptId: attempt.attemptId,
        senderAddressHex: attempt.vaultAddressHex,
        recipientAddressHex: attempt.participantWallet,
        amountLuna: attempt.amountLuna,
        feeLuna: ESTIMATED_TX_FEE_LUNA,
        networkId,
        validityStartHeight: await dependencies.getValidityStartHeight(),
      };
      prepared = assertPreparedMatchesContext(await dependencies.sign(context), context);
      preparedTransactionHash = prepared.transactionHash;
      await dependencies.store.persistPrepared(attempt.attemptId, prepared);
    }

    if (!await dependencies.store.markBroadcastStarting(attempt.attemptId)) {
      const refreshed = await dependencies.store.loadPayoutAttempt(attempt.attemptId);
      return refreshed ? attemptResult(refreshed) : { kind: "rejected", reasonCode: "attempt_not_found" };
    }
    broadcastStarted = true;

    const result = await dependencies.broadcast(prepared.serializedTransactionHex);
    if (result.kind === "broadcast") {
      const hash = normalizeHash(result.transactionHash);
      if (hash !== prepared.transactionHash) {
        await dependencies.store.recordUnknownOutcome(
          attempt.attemptId,
          "broadcast_hash_mismatch",
        );
        return {
          kind: "unknown",
          attemptId: attempt.attemptId,
          transactionHash: prepared.transactionHash,
          reasonCode: "broadcast_hash_mismatch",
        };
      }
      await dependencies.store.markBroadcastSuccess(attempt.attemptId, hash);
      return { kind: "broadcasted", attemptId: attempt.attemptId, transactionHash: hash };
    }
    if (result.kind === "definitely_not_broadcast") {
      await dependencies.store.recordDefiniteFailure(attempt.attemptId, result.errorCode);
      return { kind: "retryable", attemptId: attempt.attemptId, reasonCode: result.errorCode };
    }

    await dependencies.store.recordUnknownOutcome(attempt.attemptId, result.errorCode);
    return {
      kind: "unknown",
      attemptId: attempt.attemptId,
      transactionHash: prepared.transactionHash,
      reasonCode: result.errorCode,
    };
  } catch (error) {
    const reasonCode = safeResultError(error);
    if (broadcastStarted) {
      try {
        await dependencies.store.recordUnknownOutcome(claimedAttempt.attemptId, reasonCode);
      } catch {
        // The prepared hash and broadcast-start marker remain durable even if
        // this best-effort error annotation cannot be written.
      }
      return {
        kind: "unknown",
        attemptId: claimedAttempt.attemptId,
        transactionHash: preparedTransactionHash,
        reasonCode,
      };
    }
    try {
      await dependencies.store.recordDefiniteFailure(claimedAttempt.attemptId, reasonCode);
    } catch {
      // The claim remains durable and can be inspected/reconciled if the error
      // update itself loses its database connection.
    }
    return { kind: "retryable", attemptId: claimedAttempt.attemptId, reasonCode };
  } finally {
    try {
      await dependencies.store.releaseVaultLock(claimedAttempt.campaignId, token);
    } catch {
      // The lease expiry is the second release path if this request is lost.
    }
  }
}

function parseSnapshot(value: unknown): PayoutAttemptSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const stringField = (name: string): string | null =>
    typeof row[name] === "string" ? row[name] as string : null;
  const amountRaw = row.amount_luna;
  const amount = typeof amountRaw === "string" && /^\d+$/.test(amountRaw)
    ? BigInt(amountRaw)
    : typeof amountRaw === "number" && Number.isSafeInteger(amountRaw) && amountRaw >= 0
      ? BigInt(amountRaw)
      : null;
  if (
    !stringField("attempt_id") ||
    !stringField("receipt_id") ||
    !stringField("campaign_id") ||
    !stringField("participant_wallet") ||
    !stringField("vault_address_hex") ||
    amount === null ||
    typeof row.attempt_number !== "number" ||
    !Number.isSafeInteger(row.attempt_number) ||
    typeof row.attempt_status !== "string" ||
    typeof row.receipt_status !== "string"
  ) return null;
  return {
    attemptId: stringField("attempt_id")!,
    receiptId: stringField("receipt_id")!,
    campaignId: stringField("campaign_id")!,
    attemptNumber: row.attempt_number,
    attemptStatus: row.attempt_status as PayoutAttemptSnapshot["attemptStatus"],
    receiptStatus: row.receipt_status as PayoutAttemptSnapshot["receiptStatus"],
    participantWallet: stringField("participant_wallet")!,
    amountLuna: amount,
    vaultAddressHex: stringField("vault_address_hex")!,
    preparedTransactionHex: stringField("prepared_transaction_hex"),
    transactionHash: stringField("transaction_hash"),
    preparedFeeLuna: (() => {
      const value = row.fee_luna;
      if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
      return null;
    })(),
    preparedNetworkId: typeof row.network_id === "number" && Number.isSafeInteger(row.network_id)
      ? row.network_id
      : null,
    preparedValidityStartHeight: typeof row.validity_start_height === "number" && Number.isSafeInteger(row.validity_start_height)
      ? row.validity_start_height
      : null,
    preparedSenderAddressHex: stringField("sender_address_hex"),
    preparedRecipientAddressHex: stringField("recipient_address_hex"),
    broadcastStartedAt: stringField("broadcast_started_at"),
    broadcastAt: stringField("broadcast_at"),
  };
}

function rpcResultData(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
}

export function createSupabaseRewardPayoutStore(admin: AdminClient): RewardPayoutStore {
  const rpcClient = admin as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{
      data: unknown;
      error: unknown;
    }>;
  };

  async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await rpcClient.rpc(name, args);
    if (error) throw new Error(`database_${name}_failed`);
    const result = rpcResultData(data);
    if (!result || typeof result.result_kind !== "string") throw new Error(`database_${name}_malformed`);
    return result;
  }

  async function beginPayoutAtomic(receiptId: string, campaignId: string): Promise<PayoutClaim> {
    try {
      const result = await rpc("begin_reward_payout_atomic", {
        _receipt_id: receiptId,
        _campaign_id: campaignId,
      });
      if (result.result_kind !== "created" && result.result_kind !== "replay") {
        return { kind: "rejected", reasonCode: String(result.result_kind) };
      }
      const resultKind = result.result_kind;
      const attempt = parseSnapshot(result);
      return attempt
        ? { kind: resultKind === "created" ? "claimed" : "replay", attempt }
        : { kind: "rejected", reasonCode: "payout_claim_malformed" };
    } catch {
      return { kind: "rejected", reasonCode: "database_begin_failed" };
    }
  }

  async function loadPayoutAttempt(attemptId: string): Promise<PayoutAttemptSnapshot | null> {
    const { data: attempt, error: attemptError } = await admin
      .from("reward_payout_attempts")
      .select("id, receipt_id, attempt_number, status, transaction_hash, sender_address_hex, recipient_address_hex, amount_luna, fee_luna, network_id, validity_start_height, prepared_transaction_hex, prepared_at, broadcast_started_at, broadcast_at")
      .eq("id", attemptId)
      .maybeSingle();
    if (attemptError || !attempt) return null;
    const { data: receipt, error: receiptError } = await admin
      .from("reward_receipts")
      .select("id, campaign_id, participant_wallet, amount_luna, status")
      .eq("id", attempt.receipt_id)
      .maybeSingle();
    if (receiptError || !receipt) return null;
    const { data: vault, error: vaultError } = await admin
      .from("reward_campaign_vaults")
      .select("vault_address_hex")
      .eq("campaign_id", receipt.campaign_id)
      .maybeSingle();
    if (vaultError || !vault) return null;
    return parseSnapshot({
      attempt_id: attempt.id,
      receipt_id: receipt.id,
      campaign_id: receipt.campaign_id,
      attempt_number: attempt.attempt_number,
      attempt_status: attempt.status,
      receipt_status: receipt.status,
      participant_wallet: receipt.participant_wallet,
      amount_luna: receipt.amount_luna,
      vault_address_hex: vault.vault_address_hex,
      prepared_transaction_hex: attempt.prepared_transaction_hex,
      transaction_hash: attempt.transaction_hash,
      fee_luna: attempt.fee_luna,
      network_id: attempt.network_id,
      validity_start_height: attempt.validity_start_height,
      sender_address_hex: attempt.sender_address_hex,
      recipient_address_hex: attempt.recipient_address_hex,
      broadcast_started_at: attempt.broadcast_started_at,
      broadcast_at: attempt.broadcast_at,
    });
  }

  return {
    beginPayoutAtomic,
    loadPayoutAttempt,
    acquireVaultLock: async (campaignId, attemptId, token) => {
      try {
        const result = await rpc("acquire_reward_payout_vault_lock_atomic", {
          _campaign_id: campaignId,
          _attempt_id: attemptId,
          _lock_token: token,
          _lease_seconds: 120,
        });
        return result.result_kind === "acquired" || result.result_kind === "replay";
      } catch {
        return false;
      }
    },
    persistPrepared: async (attemptId, prepared) => {
      const result = await rpc("prepare_reward_payout_atomic", {
        _attempt_id: attemptId,
        _sender_address_hex: prepared.senderAddressHex,
        _recipient_address_hex: prepared.recipientAddressHex,
        _amount_luna: prepared.amountLuna.toString(),
        _fee_luna: prepared.feeLuna.toString(),
        _network_id: prepared.networkId,
        _validity_start_height: prepared.validityStartHeight,
        _transaction_hash: prepared.transactionHash,
        _prepared_transaction_hex: prepared.serializedTransactionHex,
      });
      if (result.result_kind !== "prepared" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    markBroadcastStarting: async (attemptId) => {
      try {
        const result = await rpc("mark_reward_payout_broadcast_starting", {
          _attempt_id: attemptId,
        });
        return result.result_kind === "started";
      } catch {
        return false;
      }
    },
    markBroadcastSuccess: async (attemptId, transactionHash) => {
      const result = await rpc("mark_reward_payout_broadcast_atomic", {
        _attempt_id: attemptId,
        _transaction_hash: transactionHash,
      });
      if (result.result_kind !== "broadcasted" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    recordDefiniteFailure: async (attemptId, errorCode) => {
      const result = await rpc("record_reward_payout_failure_atomic", {
        _attempt_id: attemptId,
        _error_code: errorCode,
      });
      if (result.result_kind !== "retryable" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    recordUnknownOutcome: async (attemptId, errorCode) => {
      const result = await rpc("record_reward_payout_unknown_atomic", {
        _attempt_id: attemptId,
        _error_code: errorCode,
      });
      if (result.result_kind !== "unknown" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    releaseVaultLock: async (campaignId, token) => {
      try {
        await rpc("release_reward_payout_vault_lock_atomic", {
          _campaign_id: campaignId,
          _lock_token: token,
        });
      } catch {
        // The lease expires independently if the release request is lost.
      }
    },
  };
}

function createDefaultPayoutDependencies(admin: AdminClient): PayoutDependencies {
  const adapter = createNimiqBroadcastAdapter();
  return {
    store: createSupabaseRewardPayoutStore(admin),
    createLockToken: randomUUID,
    getNetworkId: safeNetworkId,
    getValidityStartHeight: () => adapter.getBlockNumber(),
    broadcast: (hex) => adapter.broadcastTransaction(hex),
    sign: async (context) => withCampaignVaultKey(context.campaignId, (keypair) => {
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return {
        ...context,
        serializedTransactionHex: signed.toHex(),
        transactionHash: signed.hash(),
      };
    }),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

export async function executeReservedRewardPayout(
  admin: AdminClient,
  receiptId: string,
  campaignId: string,
): Promise<RewardPayoutResult> {
  return runRewardPayout(
    { receiptId, campaignId },
    createDefaultPayoutDependencies(admin),
  );
}
