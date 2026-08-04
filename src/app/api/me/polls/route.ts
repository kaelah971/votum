import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createServerClient, getConfigStatus } from "@/lib/supabase/config";
import { normalizeCategory, normalizeFormat } from "@/lib/polls/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function log(stage: string, data: Record<string, unknown>) {
  console.error("[me-polls]", { stage, ...data });
}

export async function GET() {
  const requestId = randomBytes(8).toString("hex");

  // Session required
  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
    return NextResponse.json(
      {
        error: "session_required",
        message: "Verify your wallet to view polls you created.",
      },
      { status: 401 },
    );
  }

  const creatorWallet = session.address;

  const config = getConfigStatus();
  if (!config.configured) {
    return NextResponse.json({ polls: [] });
  }
  const supabase = createServerClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "service_unavailable", message: "Database not configured." },
      { status: 503 },
    );
  }

  try {
    const { data: polls, error } = await supabase
      .from("polls")
      .select(
        "id, question, description, mode, destination_wallet, destination_purpose, min_nim_luna, fairness_mode, status, starts_at, ends_at, is_public, created_at, category, format",
      )
      .eq("creator_wallet", creatorWallet)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    // Fetch options for all polls
    const safePolls = polls ?? [];
    if (safePolls.length === 0) {
      return NextResponse.json({ polls: [] });
    }

    const pollIds = safePolls.map((p) => p.id);
    const { data: options, error: optErr } = await supabase
      .from("poll_options")
      .select("id, poll_id, label, sort_order")
      .in("poll_id", pollIds)
      .order("sort_order", { ascending: true });

    if (optErr) throw optErr;

    const optsByPoll = new Map<string, typeof options>();
    for (const opt of options ?? []) {
      const list = optsByPoll.get(opt.poll_id) ?? [];
      list.push(opt);
      optsByPoll.set(opt.poll_id, list);
    }

    const mapped = safePolls.map((p) => ({
      id: p.id,
      question: p.question,
      description: p.description,
      mode: p.mode === "community_support" ? "community" : "creator",
      destinationPurpose: p.destination_purpose,
      minimumNim: p.min_nim_luna,
      fairnessMode: p.fairness_mode,
      category: normalizeCategory(p.category),
      format: normalizeFormat(p.format),
      status: p.status,
      optionCount: (optsByPoll.get(p.id) ?? []).length,
      isPublic: p.is_public,
      createdAt: p.created_at,
      closingAt: p.ends_at,
    }));

    log("polls_listed", { requestId, poll_count: mapped.length, status: 200 });

    return NextResponse.json({ polls: mapped });
  } catch (err) {
    log("query_failed", { requestId, error: String(err) });
    return NextResponse.json(
      { error: "query_failed", message: "Could not retrieve your polls." },
      { status: 500 },
    );
  }
}
