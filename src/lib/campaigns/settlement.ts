import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { loadRewardSettlementContext } from "@/lib/rewards/settlement-root";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type CampaignSettlementResolution =
  | {
      kind: "ok";
      settlementId: string;
      participationCampaignId: string;
      sourceType: "participation_campaign";
      ownerWallet: string;
    }
  | { kind: "not_found"; reasonCode: "settlement_not_found" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_settlement_binding" };

/**
 * Resolve and validate the standalone Campaign source relationship without
 * changing authority. Mirrors resolvePollRewardSettlement on the
 * participation_campaign binding branch. This lives in the Campaign layer
 * (not the shared settlement root) so Poll financial modules stay free of
 * Campaign authority per the V2C.1 compatibility gate. Product type is
 * deliberately not gated here: funding is financial, while type gating
 * belongs to claim eligibility in a later slice.
 */
export async function resolveCampaignRewardSettlement(
  admin: AdminClient,
  campaignId: string,
): Promise<CampaignSettlementResolution> {
  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id, settlement_id, owner_wallet")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) return { kind: "error", reasonCode: "database_read_failed" };
  if (!campaign) return { kind: "not_found", reasonCode: "settlement_not_found" };

  const participationCampaignId = campaign.id;
  const stagingSettlementId = campaign.settlement_id;
  const campaignOwner = normalizeAddress(campaign.owner_wallet);
  if (
    !participationCampaignId ||
    participationCampaignId !== campaignId ||
    !stagingSettlementId ||
    !campaignOwner
  ) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  const { data: binding, error: bindingError } = await admin
    .from("settlement_source_bindings")
    .select("settlement_id, source_type, participation_campaign_id")
    .eq("participation_campaign_id", participationCampaignId)
    .maybeSingle();
  if (bindingError) return { kind: "error", reasonCode: "database_read_failed" };
  if (
    !binding ||
    binding.source_type !== "participation_campaign" ||
    binding.participation_campaign_id !== participationCampaignId ||
    binding.settlement_id !== stagingSettlementId
  ) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  const root = await loadRewardSettlementContext(admin, stagingSettlementId);
  if (root.kind === "not_found") return root;
  if (root.kind === "error") {
    if (root.reasonCode === "database_read_failed") {
      return { kind: "error", reasonCode: "database_read_failed" };
    }
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }
  if (root.root.ownerWallet !== campaignOwner) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  return {
    kind: "ok",
    settlementId: stagingSettlementId,
    participationCampaignId,
    sourceType: "participation_campaign",
    ownerWallet: root.root.ownerWallet,
  };
}
