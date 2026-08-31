import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pollId: string }> },
) {
  const { pollId } = await params;

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json({ contributions: [] });
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json({ contributions: [] });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ contributions: [] });
  }

  const { data: poll, error: pollError } = await admin
    .from("polls")
    .select("economic_model")
    .eq("id", pollId)
    .maybeSingle();
  if (pollError || !poll) return NextResponse.json({ contributions: [] });
  if (poll.economic_model === "reward_first") {
    return NextResponse.json({ error: "support_not_available", contributions: [] }, { status: 422 });
  }

  try {
    // Query confirmed intents initiated by this wallet, then fetch
    // contribution details by confirmed_contribution_id. This ensures
    // the user sees contributions they INITIATED, even when Nimiq Pay
    // funded them from a different account.
    const { data: intents, error: intentsErr } = await (admin as any)
      .from("nim_support_intents")
      .select("id, confirmed_contribution_id")
      .eq("initiator_wallet", session.address)
      .eq("poll_id", pollId)
      .eq("status", "confirmed")
      .not("confirmed_contribution_id", "is", null)
      .order("created_at", { ascending: false });

    if (intentsErr) throw intentsErr;

    const contributionIds = (intents ?? [])
      .map((r: Record<string, unknown>) => r.confirmed_contribution_id as string)
      .filter(Boolean);

    if (contributionIds.length === 0) {
      return NextResponse.json({ contributions: [] });
    }

    const { data: contribs, error: cErr } = await (admin as any)
      .from("nim_contributions")
      .select("id, option_id, amount_luna, transaction_hash, confirmed_at")
      .in("id", contributionIds)
      .order("confirmed_at", { ascending: false });

    if (cErr) throw cErr;

    const contributions = (contribs ?? []).map((c: Record<string, unknown>) => ({
      id: c.id,
      optionId: c.option_id,
      amountLuna: String(c.amount_luna),
      transactionHash: c.transaction_hash,
      confirmedAt: c.confirmed_at,
    }));

    return NextResponse.json({ contributions });
  } catch {
    return NextResponse.json({ contributions: [] });
  }
}
