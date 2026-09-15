import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import {
  campaignInputHasAuthorityFields,
  campaignConfigurationErrorDetails,
  createParticipationCampaign,
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

export async function POST(request: Request): Promise<NextResponse> {
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

  if (campaignInputHasAuthorityFields(body)) {
    return NextResponse.json(
      { error: "invalid_request", message: "Server-derived Campaign fields cannot be supplied." },
      { status: 400 },
    );
  }

  try {
    const result = await createParticipationCampaign(owner, body);
    return NextResponse.json(
      { campaign: toCampaignConfigurationReadModel(result.campaign) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
