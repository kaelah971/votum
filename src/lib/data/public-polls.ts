import { createServerClient, getConfigStatus } from "@/lib/supabase/config";
import type { Database } from "@/types/database";
import type { PollView, PollStatus, ContributionMode } from "@/types/poll";
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

function mapPollRow(row: PollRow, options: OptionRows): PollView {
  return {
    id: row.id,
    question: row.question,
    context: row.description ?? undefined,
    contributionMode: mapContributionMode(row.mode),
    destinationWallet: row.destination_wallet,
    destinationPurpose: row.destination_purpose,
    minimumNim: lunaToNim(row.min_nim_luna),
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
}

function mapContributionMode(mode: string): ContributionMode {
  if (mode === "community_support") return "community";
  return "creator";
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
      .select("id, question, description, mode, destination_wallet, destination_purpose, min_nim_luna, fairness_mode, status, starts_at, ends_at, is_public, created_at, category, format")
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

    const mapped = polls.map((row) =>
      mapPollRow(row as PollRow, optionsByPoll.get(row.id) ?? []),
    );

    return { success: true, polls: mapped };
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

    return {
      success: true,
      poll: mapPollRow(poll as PollRow, (options ?? []) as OptionRows),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    return { success: false, reason: "error", message };
  }
}
