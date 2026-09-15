import "server-only";

import { addressesEqual, normalizeAddress } from "@/lib/nimiq/server-crypto";
import type {
  RewardClosureContext,
  RewardClosureTrigger,
} from "@/lib/rewards/closure";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PollStatus } from "@/types/poll";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export interface PollClosureSource {
  pollId: string;
  pollStatus: PollStatus;
  endsAt: string;
  creatorWallet: string;
  settlementId: string;
  bindingSourceId: string;
}

export interface PollClosureSourceStore {
  load(pollId: string): Promise<PollClosureSource | null>;
}

export type PollClosureResolution =
  | { kind: "ready"; context: RewardClosureContext }
  | { kind: "not_found"; reasonCode: "poll_not_found" | "campaign_not_found" }
  | { kind: "not_closed"; reasonCode: "participation_window_open" }
  | { kind: "forbidden" }
  | { kind: "error"; reasonCode: "source_load_failed" | "malformed_source_binding" };

function pollStatus(value: unknown): value is PollStatus {
  return value === "draft" || value === "live" || value === "closed" || value === "cancelled";
}

function closeReason(source: PollClosureSource, now: Date): RewardClosureTrigger["reason"] | null {
  if (source.pollStatus === "closed") return "source_closed";
  if (source.pollStatus === "cancelled") return "creator_cancelled";
  if (source.pollStatus !== "live") return null;

  const endsAt = new Date(source.endsAt);
  if (Number.isNaN(endsAt.getTime())) throw new Error("poll_end_time_invalid");
  return endsAt <= now ? "elapsed" : null;
}

function triggerFor(source: PollClosureSource, now: Date): RewardClosureTrigger | null {
  const reason = closeReason(source, now);
  if (!reason) return null;
  return {
    source: { type: "poll_vote", id: source.pollId },
    settlement: {
      id: source.settlementId,
      binding: { sourceType: "poll_vote", sourceId: source.bindingSourceId },
    },
    reason,
    observedAt: now.toISOString(),
  };
}

export class PollRewardClosureAdapter {
  constructor(
    private readonly store: PollClosureSourceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolveClosureContext(
    pollId: string,
    verifiedCreatorWallet: string,
  ): Promise<PollClosureResolution> {
    let source: PollClosureSource | null;
    try {
      source = await this.store.load(pollId);
    } catch {
      return { kind: "error", reasonCode: "source_load_failed" };
    }
    if (!source) return { kind: "not_found", reasonCode: "poll_not_found" };
    if (
      source.pollId !== pollId ||
      source.bindingSourceId !== pollId ||
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
      trigger.source.type !== "poll_vote" ||
      trigger.source.id.trim() === "" ||
      trigger.settlement.binding.sourceType !== "poll_vote" ||
      trigger.settlement.binding.sourceId !== trigger.source.id
    ) return false;

    let source: PollClosureSource | null;
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

export function createSupabasePollClosureSourceStore(
  admin: AdminClient,
): PollClosureSourceStore {
  return {
    async load(pollId) {
      const { data: poll, error: pollError } = await admin
        .from("polls")
        .select("id, creator_wallet, status, ends_at")
        .eq("id", pollId)
        .maybeSingle();
      if (pollError) throw new Error("poll_lookup_failed");
      if (!poll) return null;

      const { data: campaign, error: campaignError } = await admin
        .from("reward_campaigns")
        .select("id, poll_id, settlement_id")
        .eq("poll_id", pollId)
        .maybeSingle();
      if (campaignError) throw new Error("campaign_lookup_failed");
      if (!campaign) return null;
      if (
        typeof poll.id !== "string" ||
        typeof poll.creator_wallet !== "string" ||
        !pollStatus(poll.status) ||
        typeof poll.ends_at !== "string" ||
        typeof campaign.id !== "string" ||
        typeof campaign.poll_id !== "string" ||
        typeof campaign.settlement_id !== "string"
      ) throw new Error("source_shape_invalid");

      const { data: binding, error: bindingError } = await admin
        .from("settlement_source_bindings")
        .select("settlement_id, source_type, reward_campaign_id")
        .eq("reward_campaign_id", campaign.id)
        .maybeSingle();
      if (bindingError) throw new Error("binding_lookup_failed");
      if (
        !binding ||
        binding.source_type !== "poll_reward_campaign" ||
        binding.reward_campaign_id !== campaign.id ||
        binding.settlement_id !== campaign.settlement_id
      ) throw new Error("source_shape_invalid");

      return {
        pollId: poll.id,
        pollStatus: poll.status,
        endsAt: poll.ends_at,
        creatorWallet: poll.creator_wallet,
        settlementId: campaign.settlement_id,
        bindingSourceId: campaign.poll_id,
      };
    },
  };
}
