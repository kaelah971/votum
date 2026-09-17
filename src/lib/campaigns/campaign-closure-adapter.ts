import "server-only";

import { addressesEqual, normalizeAddress } from "@/lib/nimiq/server-crypto";
import type {
  RewardClosureContext,
  RewardClosureTrigger,
} from "@/lib/rewards/closure";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface CampaignClosureSource {
  campaignId: string;
  campaignType: string;
  campaignStatus: string;
  endsAt: string | null;
  creatorWallet: string;
  settlementId: string;
  bindingSourceId: string;
}

export interface CampaignClosureSourceStore {
  load(campaignId: string): Promise<CampaignClosureSource | null>;
}

export type CampaignClosureResolution =
  | { kind: "ready"; context: RewardClosureContext }
  | { kind: "not_found"; reasonCode: "campaign_not_found" }
  | { kind: "not_closed"; reasonCode: "participation_window_open" }
  | { kind: "forbidden" }
  | { kind: "error"; reasonCode: "source_load_failed" | "malformed_source_binding" };

function closeReason(source: CampaignClosureSource, now: Date): RewardClosureTrigger["reason"] | null {
  if (source.campaignType !== "public_giveaway") return null;
  if (source.campaignStatus === "closed") return "source_closed";
  if (source.campaignStatus === "cancelled") return "creator_cancelled";
  if (source.campaignStatus !== "published") return null;

  if (source.endsAt === null) return null;
  const endsAt = new Date(source.endsAt);
  if (Number.isNaN(endsAt.getTime())) throw new Error("campaign_end_time_invalid");
  return endsAt <= now ? "elapsed" : null;
}

function triggerFor(source: CampaignClosureSource, now: Date): RewardClosureTrigger | null {
  const reason = closeReason(source, now);
  if (!reason) return null;
  return {
    source: { type: "campaign_claim", id: source.campaignId },
    settlement: {
      id: source.settlementId,
      binding: { sourceType: "campaign_claim", sourceId: source.bindingSourceId },
    },
    reason,
    observedAt: now.toISOString(),
  };
}

export class CampaignRewardClosureAdapter {
  constructor(
    private readonly store: CampaignClosureSourceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolveClosureContext(
    campaignId: string,
    verifiedCreatorWallet: string,
  ): Promise<CampaignClosureResolution> {
    let source: CampaignClosureSource | null;
    try {
      source = await this.store.load(campaignId);
    } catch {
      return { kind: "error", reasonCode: "source_load_failed" };
    }
    if (!source) return { kind: "not_found", reasonCode: "campaign_not_found" };
    if (
      source.campaignId !== campaignId ||
      source.bindingSourceId !== campaignId ||
      !source.settlementId
    ) return { kind: "error", reasonCode: "malformed_source_binding" };

    const creatorWallet = normalizeAddress(source.creatorWallet);
    if (!creatorWallet || !addressesEqual(creatorWallet, verifiedCreatorWallet)) {
      return { kind: "forbidden" };
    }

    let trigger: RewardClosureTrigger | null;
    try {
      trigger = triggerFor(source, this.now());
    } catch {
      return { kind: "error", reasonCode: "source_load_failed" };
    }
    if (!trigger) return { kind: "not_closed", reasonCode: "participation_window_open" };
    return { kind: "ready", context: { trigger } };
  }

  async revalidateTrigger(trigger: RewardClosureTrigger): Promise<boolean> {
    if (
      trigger.source.type !== "campaign_claim" ||
      trigger.source.id.trim() === "" ||
      trigger.settlement.binding.sourceType !== "campaign_claim" ||
      trigger.settlement.binding.sourceId !== trigger.source.id
    ) return false;

    let source: CampaignClosureSource | null;
    try {
      source = await this.store.load(trigger.source.id);
      if (!source) return false;
      const current = triggerFor(source, this.now());
      return current !== null &&
        current.source.id === trigger.source.id &&
        current.settlement.id === trigger.settlement.id &&
        current.settlement.binding.sourceId === trigger.settlement.binding.sourceId &&
        current.reason === trigger.reason;
    } catch {
      return false;
    }
  }
}

export function createSupabaseCampaignClosureSourceStore(
  admin: AdminClient,
): CampaignClosureSourceStore {
  return {
    async load(campaignId) {
      const { data: campaign, error: campaignError } = await admin
        .from("participation_campaigns")
        .select("id, campaign_type, status, owner_wallet, ends_at, settlement_id")
        .eq("id", campaignId)
        .maybeSingle();
      if (campaignError) throw new Error("campaign_lookup_failed");
      if (!campaign) return null;

      const { data: binding, error: bindingError } = await admin
        .from("settlement_source_bindings")
        .select("settlement_id, source_type, participation_campaign_id")
        .eq("participation_campaign_id", campaign.id)
        .maybeSingle();
      if (bindingError) throw new Error("binding_lookup_failed");
      if (
        !binding ||
        typeof campaign.id !== "string" ||
        typeof campaign.campaign_type !== "string" ||
        typeof campaign.status !== "string" ||
        typeof campaign.owner_wallet !== "string" ||
        typeof campaign.settlement_id !== "string" ||
        binding.source_type !== "participation_campaign" ||
        binding.participation_campaign_id !== campaign.id ||
        binding.settlement_id !== campaign.settlement_id
      ) throw new Error("source_shape_invalid");

      return {
        campaignId: campaign.id,
        campaignType: campaign.campaign_type,
        campaignStatus: campaign.status,
        endsAt: typeof campaign.ends_at === "string" ? campaign.ends_at : null,
        creatorWallet: campaign.owner_wallet,
        settlementId: campaign.settlement_id,
        bindingSourceId: campaign.id,
      };
    },
  };
}
