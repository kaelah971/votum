import "server-only";

import {
  createRewardClosureService,
  type RewardClosurePreparationResult,
} from "@/lib/rewards/closure";
import {
  executeRewardRefund,
  type RewardRefundResult,
} from "@/lib/rewards/refund";
import {
  CampaignRewardClosureAdapter,
  createSupabaseCampaignClosureSourceStore,
} from "@/lib/campaigns/campaign-closure-adapter";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type CampaignRefundPreparation =
  | RewardClosurePreparationResult
  | { kind: "error"; reasonCode: "campaign_not_found" | "forbidden" | "participation_window_open" | "source_unavailable" };

/**
 * Prepare a Campaign creator refund using the proven shared engine.
 *
 * Source resolution is Campaign-specific (closed or elapsed published
 * giveaway, owner-authorized); the atomic begin
 * (`begin_campaign_refund_atomic`) and the sign/broadcast execution path
 * are the existing F2/F3-proven primitives. All economics stay in the
 * locked database snapshot — the caller supplies identity only.
 */
export async function prepareCampaignRefund(
  admin: AdminClient,
  campaignId: string,
  ownerWallet: string,
  sessionTokenHash: string,
): Promise<CampaignRefundPreparation> {
  const adapter = new CampaignRewardClosureAdapter(
    createSupabaseCampaignClosureSourceStore(admin),
  );
  const resolution = await adapter.resolveClosureContext(campaignId, ownerWallet);
  if (resolution.kind === "not_found") {
    return { kind: "error", reasonCode: "campaign_not_found" };
  }
  if (resolution.kind === "forbidden") {
    return { kind: "error", reasonCode: "forbidden" };
  }
  if (resolution.kind === "not_closed") {
    return { kind: "error", reasonCode: "participation_window_open" };
  }
  if (resolution.kind === "error") {
    return { kind: "error", reasonCode: "source_unavailable" };
  }

  const service = createRewardClosureService(
    {
      revalidateTrigger: adapter.revalidateTrigger.bind(adapter),
      beginRefund: async (settlementId, tokenHash) => {
        const { data, error } = await admin.rpc("begin_campaign_refund_atomic", {
          _settlement_id: settlementId,
          _session_token_hash: tokenHash,
        });
        if (error) throw new Error("begin_campaign_refund_atomic_failed");
        return data;
      },
    },
    (settlementId, refundId) => executeRewardRefund(admin, refundId, settlementId),
  );
  return service.prepareRefund(resolution.context, {
    sessionTokenHash,
  });
}

/**
 * Execute a prepared Campaign refund (sign + broadcast + record).
 * Idempotent: replays the same intent, never a second one.
 */
export async function executeCampaignRefund(
  admin: AdminClient,
  settlementId: string,
  refundId: string,
): Promise<RewardRefundResult> {
  return executeRewardRefund(admin, refundId, settlementId);
}
