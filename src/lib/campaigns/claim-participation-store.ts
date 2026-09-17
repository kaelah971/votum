import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import type {
  CampaignRewardParticipationStore,
} from "@/lib/rewards/campaign-participation-adapter";
import type {
  RewardParticipationContext,
} from "@/lib/rewards/participation";
import type {
  RewardReservationAuthority,
} from "@/lib/rewards/reservation-service";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

/**
 * Campaign-owned persistence for the claim participation screen and the
 * reservation authority check. Lives in the Campaign layer (not the shared
 * rewards root) so Poll financial modules stay free of Campaign table
 * authority per the V2C.1 compatibility gate. Reads identity only: no
 * amount, capacity, vault, or lifecycle data, and no mutation. Every value
 * returned here is rechecked authoritatively inside
 * claim_campaign_reward_atomic.
 */
export function createSupabaseCampaignRewardParticipationStore(
  admin: AdminClient,
): CampaignRewardParticipationStore {
  return {
    loadCampaign: async (campaignId) => {
      const { data, error } = await admin
        .from("participation_campaigns")
        .select("id, campaign_type, status, owner_wallet, starts_at, ends_at")
        .eq("id", campaignId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        campaignType: data.campaign_type,
        status: data.status,
        ownerWallet: data.owner_wallet,
        startsAt: data.starts_at,
        endsAt: data.ends_at,
      };
    },
    loadSettlementBinding: async (campaignId) => {
      const { data, error } = await admin
        .from("settlement_source_bindings")
        .select("settlement_id, participation_campaign_id")
        .eq("participation_campaign_id", campaignId)
        .maybeSingle();
      if (error || !data || typeof data.settlement_id !== "string") return null;
      if (typeof data.participation_campaign_id !== "string") return null;
      return {
        settlementId: data.settlement_id,
        campaignId: data.participation_campaign_id,
      };
    },
    loadChallenge: async (challengeId) => {
      const { data, error } = await admin
        .from("campaign_claim_challenges")
        .select("id, campaign_id, participant_wallet, consumed_at")
        .eq("id", challengeId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id,
        campaignId: data.campaign_id,
        participantWallet: data.participant_wallet,
        consumed: data.consumed_at !== null,
      };
    },
  };
}

/**
 * Resolve the Campaign reservation authority from server-loaded rows:
 * Campaign, Campaign-branch binding, and challenge must agree with the
 * participation context. Returns null on any mismatch so the service fails
 * closed with authority_mismatch; the atomic RPC rechecks everything again
 * under lock.
 */
export async function loadCampaignReservationAuthority(
  admin: AdminClient,
  context: RewardParticipationContext,
): Promise<RewardReservationAuthority | null> {
  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id, owner_wallet")
    .eq("id", context.settlement.binding.sourceId)
    .maybeSingle();
  if (campaignError || !campaign) return null;

  const { data: binding, error: bindingError } = await admin
    .from("settlement_source_bindings")
    .select("settlement_id, participation_campaign_id")
    .eq("participation_campaign_id", campaign.id)
    .maybeSingle();
  if (bindingError || !binding) return null;

  const { data: challenge, error: challengeError } = await admin
    .from("campaign_claim_challenges")
    .select("id, campaign_id, participant_wallet")
    .eq("id", context.source.id)
    .maybeSingle();
  if (challengeError || !challenge) return null;

  const ownerWallet = normalizeAddress(campaign.owner_wallet);
  const participantWallet = normalizeAddress(challenge.participant_wallet);
  if (
    campaign.id !== context.settlement.binding.sourceId ||
    binding.participation_campaign_id !== campaign.id ||
    binding.settlement_id !== context.settlement.id ||
    challenge.id !== context.source.id ||
    challenge.campaign_id !== campaign.id ||
    ownerWallet === null ||
    participantWallet === null
  ) {
    return null;
  }

  return {
    sourceId: challenge.id,
    sourceType: "campaign_claim",
    settlementId: context.settlement.id,
    bindingSourceId: binding.participation_campaign_id,
    participantWallet: challenge.participant_wallet,
    ownerWallet: campaign.owner_wallet,
  };
}
