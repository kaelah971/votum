import "server-only";

import { createNimiqTransactionObservationAdapter } from "@/lib/nimiq/observation";
import {
  reconcileRewardFunding,
  type ExpectedFunding,
  type FundingObservation,
  type FundingReconciliationResult,
} from "@/lib/rewards/reconciliation";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface FundingConfirmationContext {
  campaignId: string;
  intentId: string;
  campaignStatus: string;
  fundingStatus: string;
  submittedTransactionHash: string | null;
  confirmedTransactionHash: string | null;
  reference: string;
  networkId: number;
  vaultAddress: string;
  fundingVaultAddress: string | null;
  requiredAmountLuna: bigint;
  fundingAmountLuna: bigint;
  fundedAmountLuna: bigint;
  refundableExcessLuna: bigint;
  fundedAt: string | null;
  confirmedAt: string | null;
}

export interface AtomicFundingConfirmationInput {
  campaignId: string;
  intentId: string;
  transactionHash: string;
  requiredAmountLuna: bigint;
  observedAmountLuna: bigint;
  blockNumber: number;
  transactionTimestampMs: number | null;
}

export type AtomicFundingConfirmation =
  | { kind: "confirmed"; data: Record<string, unknown> }
  | { kind: "replay"; data: Record<string, unknown> }
  | { kind: "error"; code: string; message?: string };

export type FundingConfirmationResult =
  | {
      kind: "confirmed";
      decision: FundingReconciliationResult;
      atomic: AtomicFundingConfirmation;
    }
  | {
      kind: "replay";
      campaignId: string;
      intentId: string;
      transactionHash: string;
      actualAmountLuna: bigint;
      excessAmountLuna: bigint;
      fundedAt: string | null;
      confirmedAt: string | null;
    }
  | { kind: "reconciled"; decision: FundingReconciliationResult }
  | { kind: "not_confirmable"; reasonCode: string }
  | { kind: "error"; reasonCode: string; message?: string };

export type FundingContextLoadResult =
  | { kind: "ok"; context: FundingConfirmationContext }
  | { kind: "not_found"; reasonCode: "campaign_not_found" | "intent_not_found" | "vault_not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_funding_context" };

export interface FundingConfirmationDependencies {
  observeFundingByHash: (hash: string) => Promise<FundingObservation>;
  confirmAtomic: (input: AtomicFundingConfirmationInput) => Promise<AtomicFundingConfirmation>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function integerLuna(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
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

function toAuthoritativeReplay(
  context: FundingConfirmationContext,
): FundingConfirmationResult {
  return {
    kind: "replay",
    campaignId: context.campaignId,
    intentId: context.intentId,
    transactionHash: context.confirmedTransactionHash ?? context.submittedTransactionHash ?? "",
    actualAmountLuna: context.fundedAmountLuna,
    excessAmountLuna: context.refundableExcessLuna,
    fundedAt: context.fundedAt,
    confirmedAt: context.confirmedAt,
  };
}

export async function loadFundingConfirmationContext(
  admin: AdminClient,
  pollId: string,
  intentId: string,
  funderWallet: string,
): Promise<FundingContextLoadResult> {
  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select(
      "id, funding_wallet, status, total_budget_luna, funded_amount_luna, refundable_excess_luna, funded_at",
    )
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campaignError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!campaign) return { kind: "not_found", reasonCode: "campaign_not_found" };
  if (typeof campaign.funding_wallet !== "string" ||
      campaign.funding_wallet.toLowerCase() !== funderWallet.toLowerCase()) {
    return { kind: "forbidden" };
  }

  const { data: funding, error: fundingError } = await admin
    .from("reward_funding_transactions")
    .select(
      "id, campaign_id, status, submitted_transaction_hash, confirmed_transaction_hash, reference, amount_luna, vault_wallet, confirmed_at",
    )
    .eq("id", intentId)
    .eq("campaign_id", campaign.id)
    .maybeSingle();
  if (fundingError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!funding) return { kind: "not_found", reasonCode: "intent_not_found" };

  const { data: vault, error: vaultError } = await admin
    .from("reward_campaign_vaults")
    .select("vault_address_hex")
    .eq("campaign_id", campaign.id)
    .maybeSingle();
  if (vaultError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!vault) return { kind: "not_found", reasonCode: "vault_not_found" };

  const networkId = safeNetworkId();
  const requiredAmountLuna = integerLuna(campaign.total_budget_luna);
  const fundingAmountLuna = integerLuna(funding.amount_luna);
  const fundedAmountLuna = integerLuna(campaign.funded_amount_luna);
  const refundableExcessLuna = integerLuna(campaign.refundable_excess_luna);
  if (
    networkId === null ||
    typeof campaign.id !== "string" ||
    typeof funding.id !== "string" ||
    typeof funding.reference !== "string" ||
    typeof vault.vault_address_hex !== "string" ||
    requiredAmountLuna === null ||
    fundingAmountLuna === null ||
    fundedAmountLuna === null ||
    refundableExcessLuna === null
  ) {
    return { kind: "error", reasonCode: "malformed_funding_context" };
  }

  return {
    kind: "ok",
    context: {
      campaignId: campaign.id,
      intentId: funding.id,
      campaignStatus: campaign.status,
      fundingStatus: funding.status,
      submittedTransactionHash: typeof funding.submitted_transaction_hash === "string"
        ? funding.submitted_transaction_hash
        : null,
      confirmedTransactionHash: typeof funding.confirmed_transaction_hash === "string"
        ? funding.confirmed_transaction_hash
        : null,
      reference: funding.reference,
      networkId,
      vaultAddress: vault.vault_address_hex,
      fundingVaultAddress: typeof funding.vault_wallet === "string"
        ? funding.vault_wallet
        : null,
      requiredAmountLuna,
      fundingAmountLuna,
      fundedAmountLuna,
      refundableExcessLuna,
      fundedAt: typeof campaign.funded_at === "string" ? campaign.funded_at : null,
      confirmedAt: typeof funding.confirmed_at === "string" ? funding.confirmed_at : null,
    },
  };
}

export async function reconcileFundingObservation(
  context: FundingConfirmationContext,
  observation: FundingObservation,
  confirmAtomic: (input: AtomicFundingConfirmationInput) => Promise<AtomicFundingConfirmation>,
): Promise<FundingConfirmationResult> {
  if (context.campaignStatus === "funded" && context.fundingStatus === "confirmed") {
    return toAuthoritativeReplay(context);
  }
  if (context.campaignStatus !== "funding_pending") {
    return { kind: "not_confirmable", reasonCode: "campaign_state_conflict" };
  }
  if (context.fundingStatus !== "submitted") {
    return { kind: "not_confirmable", reasonCode: "intent_state_conflict" };
  }
  if (context.submittedTransactionHash === null) {
    return { kind: "not_confirmable", reasonCode: "intent_unbound" };
  }
  if (context.fundingVaultAddress?.toLowerCase() !== context.vaultAddress.toLowerCase()) {
    return { kind: "not_confirmable", reasonCode: "vault_mismatch" };
  }
  if (context.fundingAmountLuna !== context.requiredAmountLuna) {
    return { kind: "not_confirmable", reasonCode: "funding_terms_mismatch" };
  }

  const expected: ExpectedFunding = {
    campaignId: context.campaignId,
    fundingIntentId: context.intentId,
    networkId: context.networkId,
    transactionHash: context.submittedTransactionHash,
    vaultAddress: context.vaultAddress,
    amountLuna: context.requiredAmountLuna,
    memo: context.reference,
  };
  const decision = reconcileRewardFunding(expected, observation);
  if (decision.status !== "confirmed") {
    return { kind: "reconciled", decision };
  }
  if (observation.kind !== "found" || observation.transaction.blockHeight === null) {
    return { kind: "error", reasonCode: "confirmed_observation_missing_block" };
  }

  const observedAmountLuna = observation.transaction.valueLuna;
  const observedAmountNumber = Number(observedAmountLuna);
  if (!Number.isSafeInteger(observedAmountNumber)) {
    return { kind: "error", reasonCode: "observed_amount_unsafe" };
  }

  const atomic = await confirmAtomic({
    campaignId: context.campaignId,
    intentId: context.intentId,
    transactionHash: observation.transaction.transactionHash,
    requiredAmountLuna: context.requiredAmountLuna,
    observedAmountLuna,
    blockNumber: observation.transaction.blockHeight,
    transactionTimestampMs: observation.transaction.timestampMs,
  });
  if (atomic.kind === "error") {
    return { kind: "error", reasonCode: "atomic_confirmation_failed", message: atomic.message };
  }
  return { kind: "confirmed", decision, atomic };
}

export async function reconcileFundingIntent(
  context: FundingConfirmationContext,
  dependencies: FundingConfirmationDependencies,
): Promise<FundingConfirmationResult> {
  if (context.campaignStatus === "funded" && context.fundingStatus === "confirmed") {
    return toAuthoritativeReplay(context);
  }
  if (!context.submittedTransactionHash) {
    return { kind: "not_confirmable", reasonCode: "intent_unbound" };
  }
  const observation = await dependencies.observeFundingByHash(context.submittedTransactionHash);
  return reconcileFundingObservation(context, observation, dependencies.confirmAtomic);
}

export function createDefaultFundingConfirmationDependencies(
  admin: AdminClient,
): FundingConfirmationDependencies {
  const adapter = createNimiqTransactionObservationAdapter();
  return {
    observeFundingByHash: (hash) => adapter.observeFundingByHash(hash),
    confirmAtomic: async (input) => {
      const { data, error } = await admin.rpc("confirm_reward_funding_atomic", {
        _campaign_id: input.campaignId,
        _intent_id: input.intentId,
        _transaction_hash: input.transactionHash,
        _observed_amount_luna: Number(input.observedAmountLuna),
        _block_number: input.blockNumber,
        _transaction_timestamp: input.transactionTimestampMs === null
          ? null
          : new Date(input.transactionTimestampMs).toISOString(),
      });
      if (error) {
        return { kind: "error", code: error.code, message: error.message };
      }
      const result = asRecord(data);
      const resultKind = typeof result?.result_kind === "string" ? result.result_kind : "";
      if (resultKind === "confirmed") return { kind: "confirmed", data: result ?? {} };
      if (resultKind === "replay") return { kind: "replay", data: result ?? {} };
      return { kind: "error", code: resultKind || "confirmation_rejected" };
    },
  };
}
