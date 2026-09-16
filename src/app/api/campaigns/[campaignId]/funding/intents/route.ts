import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { beginCampaignFunding } from "@/lib/campaigns/funding";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-funding-intent]", { stage, ...data });
}

function resultError(
  resultKind: string,
  requestId: string,
): { error: string; status: number; message: string } {
  switch (resultKind) {
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404, message: "Campaign not found." };
    case "forbidden":
      return { error: "forbidden", status: 403, message: "Only the Campaign owner can fund this Campaign." };
    case "vault_unavailable":
      return { error: "vault_unavailable", status: 503, message: "The Campaign vault is not available." };
    case "funding_amount_unsafe":
      return { error: "funding_amount_unsafe", status: 422, message: "The required funding amount cannot be represented safely by Nimiq Pay." };
    case "campaign_state_conflict":
      return { error: "campaign_state_conflict", status: 409, message: "This Campaign cannot begin another funding attempt." };
    default:
      log("unknown_rpc_result", { requestId, status: 500, resultKind });
      return { error: "funding_intent_failed", status: 500, message: "Could not create a funding intent." };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { campaignId } = await params;

  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "invalid_origin", stage: "origin", requestId, message: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }
  const funderWallet = normalizeAddress(session.address);
  if (!funderWallet) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId, message: "Session wallet address is invalid." },
      { status: 401 },
    );
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId, message: "Server not configured." },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  const result = await beginCampaignFunding(admin, campaignId, funderWallet);
  if (result.kind === "error") {
    const mapped = resultError(result.reasonCode, requestId);
    return NextResponse.json(
      { error: mapped.error, stage: "atomic_begin", requestId, message: mapped.message },
      { status: mapped.status },
    );
  }

  log("intent_ready", { requestId, status: result.kind === "created" ? 201 : 200 });
  return NextResponse.json(
    {
      fundingIntent: result.fundingIntent,
      campaignState: "funding_pending",
      resultKind: result.kind,
    },
    { status: result.kind === "created" ? 201 : 200 },
  );
}
