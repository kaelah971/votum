import "server-only";

import { randomUUID } from "node:crypto";
import { createNimiqBroadcastAdapter } from "@/lib/nimiq/broadcast";
import { ESTIMATED_TX_FEE_LUNA } from "@/lib/rewards/constants";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
} from "@/lib/rewards/vault-signing";
import { withCampaignVaultKey } from "@/lib/rewards/vault-service";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isRewardCampaignState,
  isRewardRefundState,
  type RewardCampaignState,
  type RewardRefundState,
} from "@/lib/rewards/states";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface RewardRefundSnapshot {
  refundId: string;
  campaignId: string;
  campaignStatus: RewardCampaignState;
  creatorWallet: string;
  amountLuna: bigint;
  status: RewardRefundState;
  vaultAddressHex: string;
  preparedTransactionHex: string | null;
  preparedTransactionHash: string | null;
  transactionHash: string | null;
  errorCode: string | null;
  preparedFeeLuna: bigint | null;
  preparedNetworkId: number | null;
  preparedValidityStartHeight: number | null;
  preparedSenderAddressHex: string | null;
  preparedRecipientAddressHex: string | null;
  preparedAt: string | null;
  broadcastStartedAt: string | null;
  broadcastAt: string | null;
}

export interface RefundSigningContext {
  campaignId: string;
  refundId: string;
  senderAddressHex: string;
  recipientAddressHex: string;
  amountLuna: bigint;
  feeLuna: bigint;
  networkId: number;
  validityStartHeight: number;
}

export interface RefundPreparedTransaction extends RefundSigningContext {
  serializedTransactionHex: string;
  transactionHash: string;
}

export interface RewardRefundStore {
  loadRefund(refundId: string, campaignId: string): Promise<RewardRefundSnapshot | null>;
  acquireVaultLock(campaignId: string, refundId: string, token: string): Promise<boolean>;
  persistPrepared(refundId: string, prepared: RefundPreparedTransaction): Promise<void>;
  markBroadcastStarting(refundId: string): Promise<boolean>;
  markBroadcastSuccess(refundId: string, transactionHash: string): Promise<void>;
  recordDefiniteFailure(refundId: string, errorCode: string): Promise<void>;
  recordUnknownOutcome(refundId: string, errorCode: string): Promise<void>;
  releaseVaultLock(campaignId: string, refundId: string, token: string): Promise<void>;
}

export type RefundBroadcastResult =
  | { kind: "broadcast"; transactionHash: string }
  | { kind: "definitely_not_broadcast"; errorCode: string }
  | { kind: "unknown"; errorCode: string }
  | { kind: "malformed"; errorCode: string };

export interface RefundDependencies {
  store: RewardRefundStore;
  createLockToken: () => string;
  sign: (context: RefundSigningContext) => Promise<RefundPreparedTransaction>;
  broadcast: (serializedTransactionHex: string) => Promise<RefundBroadcastResult>;
  getNetworkId: () => number;
  getFeeLuna: () => bigint;
  getValidityStartHeight: () => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
}

export type RewardRefundResult =
  | { kind: "broadcasted"; refundId: string; transactionHash: string }
  | { kind: "already_pending"; refundId: string; transactionHash: string | null }
  | { kind: "unknown"; refundId: string; transactionHash: string | null; reasonCode: string }
  | { kind: "retryable"; refundId: string; reasonCode: string }
  | { kind: "rejected"; reasonCode: string }
  | { kind: "busy"; refundId: string; reasonCode: "vault_busy" };

function normalizeHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("transaction_hash_invalid");
  return normalized;
}

function assertPreparedMatchesContext(
  prepared: RefundPreparedTransaction,
  context: RefundSigningContext,
): RefundPreparedTransaction {
  if (
    prepared.campaignId !== context.campaignId ||
    prepared.refundId !== context.refundId ||
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
    : "refund_preparation_failed";
}

async function acquireVaultLock(
  dependencies: RefundDependencies,
  campaignId: string,
  refundId: string,
): Promise<string | null> {
  const token = dependencies.createLockToken();
  for (let i = 0; i < 600; i++) {
    if (await dependencies.store.acquireVaultLock(campaignId, refundId, token)) return token;
    await dependencies.sleep(50);
  }
  return null;
}

function alreadyPending(refund: RewardRefundSnapshot): RewardRefundResult {
  return {
    kind: "already_pending",
    refundId: refund.refundId,
    transactionHash: refund.transactionHash,
  };
}

function durableBroadcastOutcome(refund: RewardRefundSnapshot): RewardRefundResult | null {
  if (refund.broadcastAt !== null || refund.transactionHash !== null) {
    return alreadyPending(refund);
  }
  if (refund.broadcastStartedAt !== null) {
    return {
      kind: "unknown",
      refundId: refund.refundId,
      transactionHash: refund.preparedTransactionHash,
      reasonCode: refund.errorCode ?? "broadcast_outcome_unknown",
    };
  }
  return null;
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseSnapshot(value: unknown): RewardRefundSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const stringField = (name: string): string | null =>
    typeof row[name] === "string" ? row[name] as string : null;
  const amount = integerLuna(row.amount_luna);
  const status = row.status;
  const campaignStatus = row.campaign_status;
  const networkId = row.network_id;
  const validityStartHeight = row.validity_start_height;

  if (
    !stringField("id") ||
    !stringField("campaign_id") ||
    typeof campaignStatus !== "string" ||
    !isRewardCampaignState(campaignStatus) ||
    !stringField("creator_wallet") ||
    amount === null ||
    typeof status !== "string" ||
    !isRewardRefundState(status) ||
    !stringField("vault_address_hex") ||
    (networkId !== null && networkId !== undefined &&
      (typeof networkId !== "number" || !Number.isSafeInteger(networkId) || networkId < 0)) ||
    (validityStartHeight !== null && validityStartHeight !== undefined &&
      (typeof validityStartHeight !== "number" || !Number.isSafeInteger(validityStartHeight) || validityStartHeight < 0))
  ) return null;

  return {
    refundId: stringField("id")!,
    campaignId: stringField("campaign_id")!,
    campaignStatus,
    creatorWallet: stringField("creator_wallet")!,
    amountLuna: amount,
    status,
    vaultAddressHex: stringField("vault_address_hex")!,
    preparedTransactionHex: stringOrNull(row.prepared_transaction_hex),
    preparedTransactionHash: stringOrNull(row.prepared_transaction_hash),
    transactionHash: stringOrNull(row.transaction_hash),
    errorCode: stringOrNull(row.error_code),
    preparedFeeLuna: integerLuna(row.fee_luna),
    preparedNetworkId: typeof networkId === "number" ? networkId : null,
    preparedValidityStartHeight: typeof validityStartHeight === "number" ? validityStartHeight : null,
    preparedSenderAddressHex: stringOrNull(row.sender_address_hex),
    preparedRecipientAddressHex: stringOrNull(row.recipient_address_hex),
    preparedAt: stringOrNull(row.prepared_at),
    broadcastStartedAt: stringOrNull(row.broadcast_started_at),
    broadcastAt: stringOrNull(row.broadcast_at),
  };
}

function rpcResultData(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
}

export function createSupabaseRewardRefundStore(admin: AdminClient): RewardRefundStore {
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
    if (!result || typeof result.result_kind !== "string") {
      throw new Error(`database_${name}_malformed`);
    }
    return result;
  }

  return {
    loadRefund: async (refundId, campaignId) => {
      const { data: refund, error: refundError } = await admin
        .from("reward_refunds")
        .select("id, campaign_id, creator_wallet, amount_luna, status, transaction_hash, fee_luna, network_id, validity_start_height, sender_address_hex, recipient_address_hex, prepared_transaction_hex, prepared_transaction_hash, prepared_at, broadcast_started_at, broadcast_at, error_code")
        .eq("id", refundId)
        .eq("campaign_id", campaignId)
        .maybeSingle();
      if (refundError || !refund) return null;

      const { data: campaign, error: campaignError } = await admin
        .from("reward_campaigns")
        .select("status")
        .eq("id", refund.campaign_id)
        .maybeSingle();
      if (campaignError || !campaign) return null;

      const { data: vault, error: vaultError } = await admin
        .from("reward_campaign_vaults")
        .select("vault_address_hex")
        .eq("campaign_id", refund.campaign_id)
        .maybeSingle();
      if (vaultError || !vault) return null;

      return parseSnapshot({
        id: refund.id,
        campaign_id: refund.campaign_id,
        campaign_status: campaign.status,
        creator_wallet: refund.creator_wallet,
        amount_luna: refund.amount_luna,
        status: refund.status,
        vault_address_hex: vault.vault_address_hex,
        prepared_transaction_hex: refund.prepared_transaction_hex,
        prepared_transaction_hash: refund.prepared_transaction_hash,
        transaction_hash: refund.transaction_hash,
        error_code: refund.error_code,
        fee_luna: refund.fee_luna,
        network_id: refund.network_id,
        validity_start_height: refund.validity_start_height,
        sender_address_hex: refund.sender_address_hex,
        recipient_address_hex: refund.recipient_address_hex,
        prepared_at: refund.prepared_at,
        broadcast_started_at: refund.broadcast_started_at,
        broadcast_at: refund.broadcast_at,
      });
    },
    acquireVaultLock: async (campaignId, refundId, token) => {
      try {
        const result = await rpc("acquire_reward_refund_vault_lock_atomic", {
          _campaign_id: campaignId,
          _refund_id: refundId,
          _lock_token: token,
          _lease_seconds: 120,
        });
        return result.result_kind === "acquired" || result.result_kind === "replay";
      } catch {
        return false;
      }
    },
    persistPrepared: async (refundId, prepared) => {
      const result = await rpc("prepare_reward_refund_transaction_atomic", {
        _refund_id: refundId,
        _sender_address_hex: prepared.senderAddressHex,
        _recipient_address_hex: prepared.recipientAddressHex,
        _amount_luna: prepared.amountLuna.toString(),
        _fee_luna: prepared.feeLuna.toString(),
        _network_id: prepared.networkId,
        _validity_start_height: prepared.validityStartHeight,
        _prepared_transaction_hash: prepared.transactionHash,
        _prepared_transaction_hex: prepared.serializedTransactionHex,
      });
      if (result.result_kind !== "prepared" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    markBroadcastStarting: async (refundId) => {
      try {
        const result = await rpc("mark_reward_refund_broadcast_starting_atomic", {
          _refund_id: refundId,
        });
        return result.result_kind === "started";
      } catch {
        return false;
      }
    },
    markBroadcastSuccess: async (refundId, transactionHash) => {
      const result = await rpc("mark_reward_refund_broadcast_atomic", {
        _refund_id: refundId,
        _transaction_hash: transactionHash,
      });
      if (result.result_kind !== "broadcasted" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    recordDefiniteFailure: async (refundId, errorCode) => {
      const result = await rpc("record_reward_refund_failure_atomic", {
        _refund_id: refundId,
        _error_code: errorCode,
      });
      if (result.result_kind !== "retryable" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    recordUnknownOutcome: async (refundId, errorCode) => {
      const result = await rpc("record_reward_refund_unknown_atomic", {
        _refund_id: refundId,
        _error_code: errorCode,
      });
      if (result.result_kind !== "unknown" && result.result_kind !== "replay") {
        throw new Error(String(result.result_kind));
      }
    },
    releaseVaultLock: async (campaignId, _refundId, token) => {
      try {
        await rpc("release_reward_payout_vault_lock_atomic", {
          _campaign_id: campaignId,
          _lock_token: token,
        });
      } catch {
        // The lease expiry is the second release path if this request is lost.
      }
    },
  };
}

function safeNetworkId(): number {
  const value = Number(process.env.NIMIQ_NETWORK_ID);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("nimiq_network_id_invalid");
  return value;
}

function createDefaultRefundDependencies(admin: AdminClient): RefundDependencies {
  const adapter = createNimiqBroadcastAdapter();
  return {
    store: createSupabaseRewardRefundStore(admin),
    createLockToken: randomUUID,
    getNetworkId: safeNetworkId,
    getFeeLuna: () => ESTIMATED_TX_FEE_LUNA,
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

/**
 * Sign and broadcast one prepared creator refund. The database snapshot is the
 * only source of refund economics and identity. A signed transaction and the
 * broadcast-start marker are durable before the irreversible network call.
 */
export async function runRewardRefund(
  input: { refundId: string; campaignId: string },
  dependencies: RefundDependencies,
): Promise<RewardRefundResult> {
  const initial = await dependencies.store.loadRefund(input.refundId, input.campaignId);
  if (!initial) return { kind: "rejected", reasonCode: "refund_not_found" };
  if (initial.campaignStatus !== "refunding") {
    return { kind: "rejected", reasonCode: "campaign_not_refunding" };
  }

  const initialOutcome = durableBroadcastOutcome(initial);
  if (initialOutcome) return initialOutcome;
  if (initial.status !== "pending" && initial.status !== "retryable") {
    return { kind: "rejected", reasonCode: "refund_state_conflict" };
  }

  const token = await acquireVaultLock(dependencies, initial.campaignId, initial.refundId);
  if (token === null) {
    return { kind: "busy", refundId: initial.refundId, reasonCode: "vault_busy" };
  }

  let broadcastStarted = false;
  let preparedTransactionHash: string | null = initial.preparedTransactionHash;
  try {
    const refund = await dependencies.store.loadRefund(initial.refundId, initial.campaignId);
    if (!refund) return { kind: "rejected", reasonCode: "refund_not_found" };
    if (refund.campaignStatus !== "refunding") {
      return { kind: "rejected", reasonCode: "campaign_not_refunding" };
    }

    const durableOutcome = durableBroadcastOutcome(refund);
    if (durableOutcome) return durableOutcome;
    if (refund.status !== "pending" && refund.status !== "retryable") {
      return { kind: "rejected", reasonCode: "refund_state_conflict" };
    }

    const networkId = dependencies.getNetworkId();
    if (!Number.isSafeInteger(networkId) || networkId < 0) {
      throw new Error("nimiq_network_id_invalid");
    }
    const context: RefundSigningContext = {
      campaignId: refund.campaignId,
      refundId: refund.refundId,
      senderAddressHex: refund.vaultAddressHex,
      recipientAddressHex: refund.creatorWallet,
      amountLuna: refund.amountLuna,
      feeLuna: refund.preparedFeeLuna ?? dependencies.getFeeLuna(),
      networkId,
      validityStartHeight: refund.preparedValidityStartHeight ?? await dependencies.getValidityStartHeight(),
    };

    let prepared: RefundPreparedTransaction;
    if (refund.preparedTransactionHex !== null || refund.preparedTransactionHash !== null) {
      if (
        refund.preparedTransactionHex === null ||
        refund.preparedTransactionHash === null ||
        refund.preparedFeeLuna === null ||
        refund.preparedNetworkId === null ||
        refund.preparedValidityStartHeight === null ||
        refund.preparedSenderAddressHex === null ||
        refund.preparedRecipientAddressHex === null
      ) {
        throw new Error("prepared_transaction_incomplete");
      }

      prepared = assertPreparedMatchesContext({
        campaignId: refund.campaignId,
        refundId: refund.refundId,
        senderAddressHex: refund.preparedSenderAddressHex,
        recipientAddressHex: refund.preparedRecipientAddressHex,
        amountLuna: refund.amountLuna,
        feeLuna: refund.preparedFeeLuna,
        networkId: refund.preparedNetworkId,
        validityStartHeight: refund.preparedValidityStartHeight,
        serializedTransactionHex: refund.preparedTransactionHex,
        transactionHash: refund.preparedTransactionHash,
      }, {
        ...context,
        feeLuna: refund.preparedFeeLuna,
        validityStartHeight: refund.preparedValidityStartHeight,
      });
      preparedTransactionHash = prepared.transactionHash;

      // A database failure after preparation can leave a retryable refund with
      // a valid signed transaction. Replaying the prepare RPC re-arms it.
      if (refund.status === "retryable") {
        await dependencies.store.persistPrepared(refund.refundId, prepared);
      }
    } else {
      prepared = assertPreparedMatchesContext(await dependencies.sign(context), context);
      preparedTransactionHash = prepared.transactionHash;
      await dependencies.store.persistPrepared(refund.refundId, prepared);
    }

    if (!await dependencies.store.markBroadcastStarting(refund.refundId)) {
      const refreshed = await dependencies.store.loadRefund(refund.refundId, refund.campaignId);
      if (!refreshed) return { kind: "rejected", reasonCode: "refund_not_found" };
      return durableBroadcastOutcome(refreshed) ?? alreadyPending(refreshed);
    }
    broadcastStarted = true;

    const result = await dependencies.broadcast(prepared.serializedTransactionHex);
    if (result.kind === "broadcast") {
      const hash = normalizeHash(result.transactionHash);
      if (hash !== prepared.transactionHash) {
        await dependencies.store.recordUnknownOutcome(refund.refundId, "broadcast_hash_mismatch");
        return {
          kind: "unknown",
          refundId: refund.refundId,
          transactionHash: prepared.transactionHash,
          reasonCode: "broadcast_hash_mismatch",
        };
      }
      await dependencies.store.markBroadcastSuccess(refund.refundId, hash);
      return { kind: "broadcasted", refundId: refund.refundId, transactionHash: hash };
    }
    if (result.kind === "definitely_not_broadcast") {
      await dependencies.store.recordUnknownOutcome(refund.refundId, result.errorCode);
      return {
        kind: "unknown",
        refundId: refund.refundId,
        transactionHash: prepared.transactionHash,
        reasonCode: result.errorCode,
      };
    }

    await dependencies.store.recordUnknownOutcome(refund.refundId, result.errorCode);
    return {
      kind: "unknown",
      refundId: refund.refundId,
      transactionHash: prepared.transactionHash,
      reasonCode: result.errorCode,
    };
  } catch (error) {
    const reasonCode = safeResultError(error);
    if (broadcastStarted) {
      try {
        await dependencies.store.recordUnknownOutcome(initial.refundId, reasonCode);
      } catch {
        // The prepared hash and broadcast-start marker remain durable even if
        // this best-effort error annotation cannot be written.
      }
      return {
        kind: "unknown",
        refundId: initial.refundId,
        transactionHash: preparedTransactionHash,
        reasonCode,
      };
    }

    try {
      await dependencies.store.recordDefiniteFailure(initial.refundId, reasonCode);
    } catch {
      // The durable refund state remains available for inspection/retry.
    }
    return { kind: "retryable", refundId: initial.refundId, reasonCode };
  } finally {
    try {
      await dependencies.store.releaseVaultLock(initial.campaignId, initial.refundId, token);
    } catch {
      // The lease expiry is the second release path if this request is lost.
    }
  }
}

export async function executeRewardRefund(
  admin: AdminClient,
  refundId: string,
  campaignId: string,
): Promise<RewardRefundResult> {
  return runRewardRefund(
    { refundId, campaignId },
    createDefaultRefundDependencies(admin),
  );
}
