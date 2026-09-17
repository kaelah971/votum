import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type CloseParticipationCampaignResult =
  | { kind: "closed" | "replay"; settlementId: string }
  | { kind: "error"; reasonCode: "campaign_not_found" | "forbidden" | "invalid_state" | "service_unavailable" };

function closeError(
  reasonCode: Extract<CloseParticipationCampaignResult, { kind: "error" }>["reasonCode"],
): CloseParticipationCampaignResult {
  return { kind: "error", reasonCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Owner-authorized early close. Resolves the Campaign branch and enforces
 * creator ownership, then delegates to the atomic close transaction. Carries
 * no economics and performs no product, settlement, refund, or payout
 * writes itself: the RPC locks the settlement, re-reads state, writes the
 * product and settlement close markers, and preserves every existing
 * reservation in one commit.
 */
export async function closeParticipationCampaign(
  admin: AdminClient,
  campaignId: string,
  ownerWallet: string,
): Promise<CloseParticipationCampaignResult> {
  const owner = normalizeAddress(ownerWallet);
  if (!owner || !campaignId) return closeError("forbidden");

  let campaign: { id: string; settlement_id: string; owner_wallet: string } | null;
  try {
    const loaded = await admin
      .from("participation_campaigns")
      .select("id, settlement_id, owner_wallet")
      .eq("id", campaignId)
      .maybeSingle();
    if (loaded.error) return closeError("service_unavailable");
    campaign = (loaded.data ?? null) as typeof campaign;
  } catch {
    return closeError("service_unavailable");
  }
  if (!campaign) return closeError("campaign_not_found");

  let binding: { settlement_id: string; participation_campaign_id: string } | null;
  try {
    const resolved = await admin
      .from("settlement_source_bindings")
      .select("settlement_id, participation_campaign_id")
      .eq("participation_campaign_id", campaign.id)
      .maybeSingle();
    if (resolved.error) return closeError("service_unavailable");
    binding = (resolved.data ?? null) as typeof binding;
  } catch {
    return closeError("service_unavailable");
  }
  if (
    !binding ||
    binding.participation_campaign_id !== campaign.id ||
    binding.settlement_id !== campaign.settlement_id
  ) {
    return closeError("service_unavailable");
  }
  if (normalizeAddress(campaign.owner_wallet) !== owner) {
    return closeError("forbidden");
  }

  let raw: unknown;
  try {
    const { data, error } = await admin.rpc("close_participation_campaign_atomic", {
      _campaign_id: campaign.id,
      _owner_wallet: owner,
    });
    if (error) return closeError("service_unavailable");
    raw = data;
  } catch {
    return closeError("service_unavailable");
  }
  if (!isRecord(raw) || typeof raw.result_kind !== "string") {
    return closeError("service_unavailable");
  }
  if (raw.result_kind === "closed" || raw.result_kind === "replay") {
    if (typeof raw.settlement_id !== "string" || raw.settlement_id !== campaign.settlement_id) {
      return closeError("service_unavailable");
    }
    return { kind: raw.result_kind, settlementId: raw.settlement_id };
  }
  if (
    raw.result_kind === "campaign_not_found" ||
    raw.result_kind === "forbidden" ||
    raw.result_kind === "invalid_state"
  ) {
    return { kind: "error", reasonCode: raw.result_kind };
  }
  return closeError("service_unavailable");
}
