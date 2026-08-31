import { createServerClient, getConfigStatus } from "@/lib/supabase/config";
import type { Database } from "@/types/database";
import type {
  PollView,
  PollStatus,
  ContributionMode,
  RewardFirstPollView,
} from "@/types/poll";
import type { PublicRewardCampaign } from "@/types/rewards";
import {
  isRewardCampaignState,
  REWARD_CAMPAIGN_ADVERTISED_STATES,
} from "@/lib/rewards/states";
import { lunaToNim } from "@/lib/nimiq/units";
import { normalizeCategory, normalizeFormat } from "@/lib/polls/taxonomy";

type PollRow = Database["public"]["Tables"]["polls"]["Row"];
type PollOptionRow = Database["public"]["Tables"]["poll_options"]["Row"];
type OptionRows = PollOptionRow[];

export type PollsResult =
  | { success: true; polls: PollView[] }
  | { success: false; reason: "unconfigured" | "error"; message: string };

export type PollResult =
  | { success: true; poll: PollView }
  | { success: false; reason: "unconfigured" | "not_found" | "error"; message: string };

export function mapPollRow(
  row: PollRow,
  options: OptionRows,
  rewardCampaign?: PublicRewardCampaign,
): PollView | null {
  const shared = {
    id: row.id,
    question: row.question,
    context: row.description ?? undefined,
    fairnessMode: row.fairness_mode,
    category: normalizeCategory(row.category),
    format: normalizeFormat(row.format),
    createdAt: row.created_at,
    closingAt: row.ends_at,
    status: row.status as PollStatus,
    options: options
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((opt) => ({
        id: opt.id,
        label: opt.label,
      })),
  };

  if (row.economic_model === "legacy_support") {
    if (
      !row.mode ||
      !row.destination_wallet ||
      !row.destination_purpose ||
      row.min_nim_luna === null
    ) {
      return null;
    }

    return {
      ...shared,
      economicModel: "legacy_support",
      rewardMode: null,
      contributionMode: mapContributionMode(row.mode),
      destinationWallet: row.destination_wallet,
      destinationPurpose: row.destination_purpose,
      minimumNim: lunaToNim(row.min_nim_luna),
    };
  }

  if (row.economic_model !== "reward_first") return null;
  if (row.reward_mode !== "free" && row.reward_mode !== "rewarded") {
    return null;
  }

  const rewardPoll: RewardFirstPollView = {
    ...shared,
    economicModel: "reward_first",
    rewardMode: row.reward_mode,
    ...(row.reward_mode === "rewarded" && rewardCampaign
      ? { rewardCampaign }
      : {}),
  };
  return rewardPoll;
}

function mapContributionMode(mode: string): ContributionMode {
  return mode === "community_support" ? "community" : "creator";
}

export function mapPublicRewardCampaign(
  value: unknown,
): PublicRewardCampaign | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.result_kind !== "found" || raw.funded !== true) return undefined;
  if (
    typeof raw.pollId !== "string" ||
    typeof raw.campaignId !== "string" ||
    typeof raw.status !== "string" ||
    !isRewardCampaignState(raw.status) ||
    typeof raw.rewardPerParticipantLuna !== "string" ||
    typeof raw.maxRewardedParticipants !== "number" ||
    typeof raw.rewardPrincipalLuna !== "string" ||
    typeof raw.rewardsRemaining !== "number" ||
    !/^\d+$/.test(raw.rewardPerParticipantLuna) ||
    !/^\d+$/.test(raw.rewardPrincipalLuna) ||
    !Number.isSafeInteger(raw.maxRewardedParticipants) ||
    raw.maxRewardedParticipants < 0 ||
    !Number.isSafeInteger(raw.rewardsRemaining) ||
    raw.rewardsRemaining < 0
  ) {
    return undefined;
  }
  if (!REWARD_CAMPAIGN_ADVERTISED_STATES.includes(raw.status)) {
    return undefined;
  }

  return {
    pollId: raw.pollId,
    campaignId: raw.campaignId,
    status: raw.status,
    rewardPerParticipantLuna: raw.rewardPerParticipantLuna,
    maxRewardedParticipants: raw.maxRewardedParticipants,
    rewardPrincipalLuna: raw.rewardPrincipalLuna,
    rewardsRemaining: raw.rewardsRemaining,
    funded: true,
  };
}

async function loadPublicRewardCampaign(
  supabase: ReturnType<typeof createServerClient>,
  pollId: string,
): Promise<PublicRewardCampaign | undefined> {
  if (!supabase) return undefined;
  const { data, error } = await supabase.rpc("get_public_reward_campaign", {
    _poll_id: pollId,
  });
  if (error) return undefined;
  return mapPublicRewardCampaign(data);
}

export async function listPublicPolls(): Promise<PollsResult> {
  const config = getConfigStatus();
  if (!config.configured) {
    return {
      success: false,
      reason: "unconfigured",
      message: config.reason,
    };
  }

  const supabase = createServerClient();
  if (!supabase) {
    return {
      success: false,
      reason: "unconfigured",
      message: "Supabase client could not be created",
    };
  }

  try {
    const { data: polls, error } = await supabase
      .from("polls")
      .select("id, question, description, mode, destination_wallet, destination_purpose, min_nim_luna, fairness_mode, status, starts_at, ends_at, is_public, created_at, category, format, economic_model, reward_mode")
      .in("status", ["live", "closed"])
      .eq("is_public", true)
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!polls) return { success: true, polls: [] };
    if (polls.length === 0) return { success: true, polls: [] };

    const pollIds = polls.map((p) => p.id);

    const { data: options, error: optionsError } = await supabase
      .from("poll_options")
      .select("id, poll_id, label, sort_order, created_at")
      .in("poll_id", pollIds)
      .order("sort_order", { ascending: true });

    if (optionsError) throw optionsError;

    const optionsByPoll = new Map<string, OptionRows>();
    for (const opt of options ?? []) {
      const list = optionsByPoll.get(opt.poll_id) ?? [];
      list.push(opt);
      optionsByPoll.set(opt.poll_id, list);
    }

    const mapped = await Promise.all(
      polls.map(async (row) => {
        const pollRow = row as PollRow;
        const rewardCampaign =
          pollRow.economic_model === "reward_first" &&
          pollRow.reward_mode === "rewarded"
            ? await loadPublicRewardCampaign(supabase, pollRow.id)
            : undefined;
        return mapPollRow(
          pollRow,
          optionsByPoll.get(row.id) ?? [],
          rewardCampaign,
        );
      }),
    );

    return { success: true, polls: mapped.filter((poll): poll is PollView => poll !== null) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    return { success: false, reason: "error", message };
  }
}

export async function getPublicPollById(pollId: string): Promise<PollResult> {
  if (
    !pollId.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  ) {
    return {
      success: false,
      reason: "not_found",
      message: "Invalid poll ID format",
    };
  }

  const config = getConfigStatus();
  if (!config.configured) {
    return {
      success: false,
      reason: "unconfigured",
      message: config.reason,
    };
  }

  const supabase = createServerClient();
  if (!supabase) {
    return {
      success: false,
      reason: "unconfigured",
      message: "Supabase client could not be created",
    };
  }

  try {
    const { data: poll, error } = await supabase
      .from("polls")
      .select("*")
      .eq("id", pollId)
      .eq("is_public", true)
      .in("status", ["live", "closed"])
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return { success: false, reason: "not_found", message: "Poll not found" };
      }
      throw error;
    }
    if (!poll) {
      return { success: false, reason: "not_found", message: "Poll not found" };
    }

    const { data: options, error: optionsError } = await supabase
      .from("poll_options")
      .select("id, poll_id, label, sort_order, created_at")
      .eq("poll_id", pollId)
      .order("sort_order", { ascending: true });

    if (optionsError) throw optionsError;

    const pollRow = poll as PollRow;
    const rewardCampaign =
      pollRow.economic_model === "reward_first" &&
      pollRow.reward_mode === "rewarded"
        ? await loadPublicRewardCampaign(supabase, pollRow.id)
        : undefined;
    const mapped = mapPollRow(
      pollRow,
      (options ?? []) as OptionRows,
      rewardCampaign,
    );
    if (!mapped) {
      return {
        success: false,
        reason: "error",
        message: "Poll data is invalid",
      };
    }

    return { success: true, poll: mapped };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    return { success: false, reason: "error", message };
  }
}
