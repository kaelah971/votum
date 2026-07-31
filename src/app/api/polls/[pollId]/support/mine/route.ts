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

  try {
    const { data, error } = await (admin as any)
      .from("nim_contributions")
      .select("id, option_id, amount_luna, transaction_hash, confirmed_at")
      .eq("poll_id", pollId)
      .eq("supporter_wallet", session.address)
      .order("confirmed_at", { ascending: false });

    if (error) throw error;

    const contributions = (data ?? []).map((c: Record<string, unknown>) => ({
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
