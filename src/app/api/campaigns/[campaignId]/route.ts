import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import {
  campaignConfigurationErrorDetails,
  toCampaignConfigurationReadModel,
  updateParticipationCampaignDraft,
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

export async function PATCH(
  request: Request,
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

  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return NextResponse.json(
      { error: "unsupported_media_type", message: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { campaignId } = await params;
  try {
    const result = await updateParticipationCampaignDraft(owner, campaignId, body);
    return NextResponse.json({ campaign: toCampaignConfigurationReadModel(result.campaign) });
  } catch (error) {
    return errorResponse(error);
  }
}
