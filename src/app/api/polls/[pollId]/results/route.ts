import { NextResponse } from "next/server";
import { createServerClient, getConfigStatus } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const { data, error } = await supabase.rpc("get_public_poll_results", {
    _poll_id: pollId,
  });

  if (error || !data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const r = data as Record<string, unknown>;
  if (r.result_kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(r);
}
