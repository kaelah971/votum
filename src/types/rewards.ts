import type {
  RewardCampaignState,
  RewardFundingState,
  RewardPayoutAttemptState,
  RewardReceiptState,
  RewardRefundState,
} from "@/lib/rewards/states";

/**
 * Reward-domain DB row types (V2B.2), mirroring the migration tables.
 *
 * Privacy rule: NO reward table carries `option_id` / selected-option data —
 * these shapes have no option field by construction.
 */

export interface RewardCampaignRow {
  id: string;
  poll_id: string;
  creator_wallet: string;
  funding_mode: "creator" | "community";
  funding_wallet: string;
  reward_per_participant_luna: number;
  max_rewarded_participants: number;
  reward_principal_luna: number;
  fee_reserve_luna: number;
  total_budget_luna: number;
  asset: "NIM";
  status: RewardCampaignState;
  funded_amount_luna: number;
  refundable_excess_luna: number;
  rewarded_participant_count: number;
  paid_amount_luna: number;
  payout_lock_attempt_id: string | null;
  payout_lock_token: string | null;
  payout_lock_expires_at: string | null;
  fee_spent_luna: number;
  refundable_amount_luna: number;
  first_reservation_at: string | null;
  vault_wallet: string | null;
  vault_key_ref: string | null;
  created_at: string;
  funded_at: string | null;
  closed_at: string | null;
  refunded_at: string | null;
  updated_at: string;
}

export interface RewardFundingTransactionRow {
  id: string;
  campaign_id: string;
  creator_wallet: string;
  funder_wallet: string;
  reference: string;
  submitted_transaction_hash: string | null;
  confirmed_transaction_hash: string | null;
  amount_luna: number;
  vault_wallet: string | null;
  reward_principal_luna: number | null;
  fee_reserve_luna: number | null;
  status: RewardFundingState;
  confirmation_deadline: string | null;
  submitted_at: string | null;
  block_number: number | null;
  transaction_timestamp: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RewardReceiptRow {
  id: string;
  campaign_id: string;
  poll_id: string;
  participant_wallet: string;
  amount_luna: number;
  status: RewardReceiptState;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RewardPayoutAttemptRow {
  id: string;
  receipt_id: string;
  attempt_number: number;
  status: RewardPayoutAttemptState;
  transaction_hash: string | null;
  sender_address_hex: string | null;
  recipient_address_hex: string | null;
  amount_luna: number | null;
  fee_luna: number | null;
  network_id: number | null;
  validity_start_height: number | null;
  prepared_transaction_hex: string | null;
  prepared_at: string | null;
  broadcast_started_at: string | null;
  error_code: string | null;
  broadcast_at: string | null;
  confirmed_network_id: number | null;
  confirmed_block_number: number | null;
  confirmed_transaction_timestamp: string | null;
  confirmed_transaction_block_hash: string | null;
  confirmed_canonical_block_hash: string | null;
  confirmed_batch_number: number | null;
  confirmed_finalizing_macro_block_height: number | null;
  confirmed_finalizing_macro_block_hash: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RewardRefundRow {
  id: string;
  campaign_id: string;
  creator_wallet: string;
  amount_luna: number;
  status: RewardRefundState;
  transaction_hash: string | null;
  block_number: number | null;
  transaction_timestamp: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Public reward-campaign surface (D7 allowlist). */
export interface PublicRewardCampaign {
  pollId: string;
  campaignId: string;
  status: RewardCampaignState;
  rewardPerParticipantLuna: string;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: string;
  rewardsRemaining: number;
  funded: boolean;
}
