import "server-only";

import { formatNimAmount } from "@/lib/nimiq/units";
import { toUserFriendlyAddress } from "@/lib/nimiq/server-crypto";

export interface FundingIntentResponse {
  fundingIntentId: string;
  campaignId: string;
  reference: string;
  memo: string;
  vaultAddressHex: string;
  vaultAddressNq: string;
  rewardPrincipalLuna: string;
  feeReserveLuna: string;
  requiredFundingLuna: string;
  requiredFundingNim: string;
  submittedTransactionHash: string | null;
  confirmationDeadline: string | null;
  createdAt: string;
}

/**
 * Convert the narrow JSON returned by the funding RPC into the browser-safe
 * funding request shape. The RPC is the source of every economic field.
 */
export function mapFundingIntentResult(raw: unknown): FundingIntentResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const fundingIntentId = typeof value.intent_id === "string" ? value.intent_id : "";
  const campaignId = typeof value.campaign_id === "string" ? value.campaign_id : "";
  const reference = typeof value.reference === "string" ? value.reference : "";
  const vaultAddressHex = typeof value.vault_wallet === "string" ? value.vault_wallet : "";
  const rewardPrincipalLuna = typeof value.reward_principal_luna === "string"
    ? value.reward_principal_luna
    : "";
  const feeReserveLuna = typeof value.fee_reserve_luna === "string"
    ? value.fee_reserve_luna
    : "";
  const requiredFundingLuna = typeof value.amount_luna === "string"
    ? value.amount_luna
    : "";
  const confirmationDeadline = typeof value.confirmation_deadline === "string"
    ? value.confirmation_deadline
    : null;
  const createdAt = typeof value.created_at === "string" ? value.created_at : "";

  if (
    !fundingIntentId ||
    !campaignId ||
    !reference ||
    !vaultAddressHex ||
    !rewardPrincipalLuna ||
    !feeReserveLuna ||
    !requiredFundingLuna ||
    !createdAt
  ) {
    return null;
  }

  let requiredFundingNim: string;
  try {
    requiredFundingNim = formatNimAmount(BigInt(requiredFundingLuna));
  } catch {
    return null;
  }

  const vaultAddressNq = toUserFriendlyAddress(vaultAddressHex);
  if (!vaultAddressNq) return null;

  return {
    fundingIntentId,
    campaignId,
    reference,
    memo: reference,
    vaultAddressHex,
    vaultAddressNq,
    rewardPrincipalLuna,
    feeReserveLuna,
    requiredFundingLuna,
    requiredFundingNim,
    submittedTransactionHash:
      typeof value.submitted_transaction_hash === "string"
        ? value.submitted_transaction_hash
        : null,
    confirmationDeadline,
    createdAt,
  };
}
