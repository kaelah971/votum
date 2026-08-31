import { NextResponse } from "next/server";
import { createServerClient, getConfigStatus } from "@/lib/supabase/config";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/polls/[pollId]/support/results
 *
 * Public endpoint — no session required. Returns aggregate NIM support
 * totals per option via the SECURITY DEFINER database function
 * `get_public_support_results`, which is accessible to the anon role
 * and reads only from public polls.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pollId: string }> },
) {
  const { pollId } = await params;

  const config = getConfigStatus();
  if (!config.configured) {
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }

  const supabase = createServerClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }

  const { data: poll, error: pollError } = await supabase
    .from("polls")
    .select("economic_model")
    .eq("id", pollId)
    .eq("is_public", true)
    .maybeSingle();
  if (pollError || !poll) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (poll.economic_model === "reward_first") {
    return NextResponse.json(
      { error: "support_not_available", message: "New polls do not have participant support results." },
      { status: 422 },
    );
  }

  // get_public_support_results not in generated Database types — cast to `any`
  const { data, error } = await (supabase.rpc as any)(
    "get_public_support_results",
    { _poll_id: pollId },
  );

  if (error || !data) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404 },
    );
  }

  return NextResponse.json(data);
}
