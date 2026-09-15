import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type AdminClient = SupabaseClient<Database>;
type Campaign = Database["public"]["Tables"]["reward_campaigns"]["Row"];

/** Attach a test Poll campaign to the already-approved V2C.2A root shape. */
export async function attachPollSettlement(
  admin: AdminClient,
  campaignId: string,
): Promise<void> {
  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();
  if (campaignError || !campaign) {
    throw campaignError ?? new Error("campaign fixture missing");
  }

  const c = campaign as Campaign;
  const { error: settlementError } = await admin.from("reward_settlements").insert({
    id: c.id,
    owner_wallet: c.creator_wallet,
    funding_wallet: c.funding_wallet,
    refund_recipient_wallet: c.creator_wallet,
    funding_mode: c.funding_mode,
    asset: c.asset,
    reward_per_participant_luna: c.reward_per_participant_luna,
    max_rewarded_participants: c.max_rewarded_participants,
    reward_principal_luna: c.reward_principal_luna,
    fee_reserve_luna: c.fee_reserve_luna,
    total_budget_luna: c.total_budget_luna,
    status: c.status,
    funded_amount_luna: c.funded_amount_luna,
    refundable_excess_luna: c.refundable_excess_luna,
    rewarded_participant_count: c.rewarded_participant_count,
    paid_amount_luna: c.paid_amount_luna,
    fee_spent_luna: c.fee_spent_luna,
    refundable_amount_luna: c.refundable_amount_luna,
    first_reservation_at: c.first_reservation_at,
    payout_lock_attempt_id: c.payout_lock_attempt_id,
    payout_lock_expires_at: c.payout_lock_expires_at,
    payout_lock_token: c.payout_lock_token,
    created_at: c.created_at,
    funded_at: c.funded_at,
    closed_at: c.closed_at,
    refunded_at: c.refunded_at,
    updated_at: c.updated_at,
  });
  if (settlementError) throw settlementError;

  const { error: campaignUpdateError } = await admin
    .from("reward_campaigns")
    .update({ settlement_id: c.id })
    .eq("id", c.id);
  if (campaignUpdateError) throw campaignUpdateError;

  const { error: bindingError } = await admin.from("settlement_source_bindings").insert({
    settlement_id: c.id,
    source_type: "poll_reward_campaign",
    reward_campaign_id: c.id,
  });
  if (bindingError) throw bindingError;
}
