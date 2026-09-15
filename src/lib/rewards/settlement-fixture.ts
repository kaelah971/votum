import { randomBytes, randomUUID } from "node:crypto";
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

  // Legacy fixture rows are inserted before their root because this helper is
  // shared by the pre-cutover DB suites. The cutover trigger permits exactly
  // this one-time stable binding and rejects every later compatibility change.
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

export type PollCampaignFixture = {
  pollId: string;
  campaignId: string;
  creatorWallet: string;
};

/**
 * Create a self-contained Poll campaign with its settlement root and Poll
 * binding (settlement id == campaign id). Synthetic local-test data only.
 * Defaults to `configured` so a vault can be ensured for the settlement.
 */
export async function createPollCampaignFixture(
  admin: AdminClient,
  options: { status?: string; question?: string } = {},
): Promise<PollCampaignFixture> {
  const creatorWallet = "01" + randomBytes(19).toString("hex");
  const { data: poll, error: pollError } = await admin.from("polls").insert({
    creator_wallet: creatorWallet,
    question: options.question ?? `V2C.2E cutover fixture ${randomUUID()}`,
    description: null,
    economic_model: "reward_first",
    reward_mode: "rewarded",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "closed",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() - 1_000).toISOString(),
    is_public: true,
    published_at: new Date(Date.now() - 86_400_000).toISOString(),
  }).select("id").single();
  if (pollError || !poll) throw pollError ?? new Error("poll fixture missing");

  const { data: campaign, error: campaignError } = await admin.from("reward_campaigns").insert({
    poll_id: poll.id,
    creator_wallet: creatorWallet,
    funding_mode: "creator",
    funding_wallet: creatorWallet,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 10,
    reward_principal_luna: 10000,
    fee_reserve_luna: 1000,
    total_budget_luna: 11000,
    status: options.status ?? "configured",
    funded_amount_luna: 0,
    refundable_excess_luna: 0,
    paid_amount_luna: 0,
    fee_spent_luna: 0,
    refundable_amount_luna: 0,
    vault_wallet: creatorWallet,
    funded_at: new Date(Date.now() - 86_400_000).toISOString(),
  }).select("id").single();
  if (campaignError || !campaign) throw campaignError ?? new Error("campaign fixture missing");
  await attachPollSettlement(admin, campaign.id);

  return { pollId: poll.id, campaignId: campaign.id, creatorWallet };
}

function quoteList(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/**
 * Delete synthetic Poll-campaign fixtures in FK-safe order (children before
 * parents). Runs under `session_replication_role = replica` like the other
 * DB suites so trigger guards never block fixture teardown.
 */
export function deletePollCampaignFixtureSql(campaignIds: string[], pollIds: string[]): string {
  const campaigns = quoteList(campaignIds);
  const polls = quoteList(pollIds);
  return `
    SET session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts
      WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE campaign_id IN (${campaigns}));
    DELETE FROM public.reward_receipts WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_funding_transactions WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_refunds WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults
      WHERE campaign_id IN (${campaigns}) OR settlement_id IN (${campaigns});
    DELETE FROM public.settlement_source_bindings WHERE reward_campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${campaigns});
    DELETE FROM public.polls WHERE id IN (${polls});
    SET session_replication_role = origin;
  `;
}
