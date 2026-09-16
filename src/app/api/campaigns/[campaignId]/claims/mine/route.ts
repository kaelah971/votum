import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { getOwnCampaignClaim } from "@/lib/campaigns/public-giveaway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const { campaignId } = await params;

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", message: "A verified wallet session is required." },
      { status: 401 },
    );
  }
  const sessionWallet = normalizeAddress(session.address);
  if (!sessionWallet) {
    return NextResponse.json(
      { error: "session_invalid", message: "Session wallet address is invalid." },
      { status: 401 },
    );
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      { error: "service_unavailable", message: "Server not configured." },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  // Scoped strictly to the (settlement, session wallet) tuple. Creates
  // nothing and consumes no challenge.
  const claim = await getOwnCampaignClaim(admin, campaignId, sessionWallet);
  if (!claim) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(claim);
}
