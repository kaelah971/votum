import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import {
  CampaignClaimChallengeError,
  issueCampaignClaimChallenge,
} from "@/lib/campaigns/claim-challenge";
import { getPublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-claim-challenge]", { stage, ...data });
}

function unavailable(reasonCode: string, requestId: string): NextResponse {
  return NextResponse.json(
    { error: "claim_not_available", reasonCode, stage: "screening", requestId },
    { status: 422 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { campaignId } = await params;

  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "invalid_origin", stage: "origin", requestId },
      { status: 403 },
    );
  }

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId },
      { status: 401 },
    );
  }
  const sessionWallet = normalizeAddress(session.address);
  if (!sessionWallet) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId },
      { status: 401 },
    );
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId },
      { status: 503 },
    );
  }

  // Courtesy screening only: the authoritative eligibility decision stays in
  // the future atomic claim transaction. A valid challenge is authorization,
  // not a reservation.
  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id, campaign_type, visibility, status, owner_wallet")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) {
    log("campaign_load_failed", { requestId, status: 500 });
    return NextResponse.json(
      { error: "challenge_failed", stage: "screening", requestId },
      { status: 500 },
    );
  }
  if (!campaign) {
    return NextResponse.json(
      { error: "campaign_not_found", stage: "screening", requestId },
      { status: 404 },
    );
  }
  if (campaign.campaign_type !== "public_giveaway") {
    return unavailable("unsupported_type", requestId);
  }
  if (
    campaign.status === "draft" ||
    campaign.status === "cancelled" ||
    campaign.visibility === "private"
  ) {
    return unavailable("not_published", requestId);
  }
  if (normalizeAddress(campaign.owner_wallet) === sessionWallet) {
    return unavailable("creator_ineligible", requestId);
  }

  const giveaway = await getPublicCampaignGiveaway(admin, campaignId);
  if (!giveaway) {
    log("projection_missing", { requestId, status: 500 });
    return NextResponse.json(
      { error: "challenge_failed", stage: "screening", requestId },
      { status: 500 },
    );
  }
  if (giveaway.claimState === "needs_funding") return unavailable("funding_pending", requestId);
  if (giveaway.claimState === "starts_soon") return unavailable("not_started", requestId);
  if (giveaway.claimState === "ended") return unavailable("ended", requestId);
  if (giveaway.claimState === "closed") return unavailable("closed", requestId);
  if (giveaway.claimState === "unpublished") return unavailable("not_published", requestId);

  try {
    const issued = await issueCampaignClaimChallenge(admin, {
      campaignId,
      sessionAddress: sessionWallet,
    });
    return NextResponse.json(issued, { status: 201 });
  } catch (error) {
    if (error instanceof CampaignClaimChallengeError && error.code === "campaign_not_found") {
      return NextResponse.json(
        { error: "campaign_not_found", stage: "challenge", requestId },
        { status: 404 },
      );
    }
    log("challenge_issue_failed", { requestId, status: 500 });
    return NextResponse.json(
      { error: "challenge_failed", stage: "challenge", requestId },
      { status: 500 },
    );
  }
}
