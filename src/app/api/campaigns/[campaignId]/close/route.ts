import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { closeParticipationCampaign } from "@/lib/campaigns/close";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-close]", { stage, ...data });
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

  // Owner identity comes only from the verified session. The request body
  // carries no authority and is ignored.
  const result = await closeParticipationCampaign(admin, campaignId, sessionWallet);
  switch (result.kind) {
    case "closed":
    case "replay":
      return NextResponse.json(
        { settlementId: result.settlementId, closed: true },
        { status: 200 },
      );
    case "error":
      switch (result.reasonCode) {
        case "campaign_not_found":
          return NextResponse.json(
            { error: "campaign_not_found", stage: "close", requestId },
            { status: 404 },
          );
        case "forbidden":
          return NextResponse.json(
            { error: "forbidden", stage: "close", requestId },
            { status: 403 },
          );
        case "invalid_state":
          return NextResponse.json(
            { error: "invalid_state", stage: "close", requestId },
            { status: 409 },
          );
        default:
          log("close_failed", { requestId, status: 500, reasonCode: result.reasonCode });
          return NextResponse.json(
            { error: "service_unavailable", stage: "close", requestId },
            { status: 503 },
          );
      }
  }
}
