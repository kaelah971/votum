import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import {
  campaignConfigurationErrorDetails,
  loadCampaignFundingReadiness,
  toCampaignConfigurationReadModel,
} from "@/lib/campaigns/configuration";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  const details = campaignConfigurationErrorDetails(error);
  return NextResponse.json(
    {
      error: details.error,
      message: details.message,
      ...(details.fieldErrors ? { fieldErrors: details.fieldErrors } : {}),
    },
    { status: details.status },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const owner = normalizeAddress(session.address);
  if (!owner) {
    return NextResponse.json(
      { error: "session_invalid", message: "Session wallet address is invalid." },
      { status: 401 },
    );
  }

  const { campaignId } = await params;
  try {
    const result = await loadCampaignFundingReadiness(owner, campaignId);
    return NextResponse.json({
      campaign: toCampaignConfigurationReadModel(result.campaign),
      fundingReadiness: result.fundingReadiness,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
