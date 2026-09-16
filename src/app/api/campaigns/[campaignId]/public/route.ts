import { NextResponse } from "next/server";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { getPublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const { campaignId } = await params;

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  // The projector is the only reader: allowlisted public fields derived
  // from authoritative rows. No session, challenge, receipt, vault, lease,
  // attempt, or refund data can reach this response.
  const giveaway = await getPublicCampaignGiveaway(admin, campaignId);
  if (!giveaway) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(giveaway);
}
