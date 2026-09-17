import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { confirmCampaignFunding } from "@/lib/campaigns/funding";

export const runtime = "nodejs";

function statusForResult(result: Awaited<ReturnType<typeof confirmCampaignFunding>>): number {
  if (result.kind === "confirmed" || result.kind === "replay") return 200;
  if (result.kind === "reconciled") {
    if (result.decision.status === "retryable") return 503;
    if (result.decision.status === "rejected") return 422;
    return 200;
  }
  if (result.kind === "not_confirmable") return 409;
  if (result.kind === "forbidden") return 403;
  if (result.kind === "not_found") return 404;
  return 500;
}

/**
 * Source-neutral engine vocabulary translated at the Campaign boundary; the
 * shared engine never emits Campaign wording. Error-kind responses keep the
 * shipped 500 status; only the vocabulary is contained.
 */
function translateConfirmReason(reasonCode: string): string {
  switch (reasonCode) {
    case "settlement_not_found":
    case "source_not_supported":
      return "campaign_not_found";
    case "funding_not_allowed":
      return "forbidden";
    case "funding_conflict":
      return "campaign_state_conflict";
    default:
      return reasonCode;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string; intentId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { campaignId, intentId } = await params;

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

  if (!getAdminConfigStatus().configured) {
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

  const result = await confirmCampaignFunding(admin, campaignId, intentId, funderWallet);
  if (result.kind === "forbidden" || result.kind === "not_found" || result.kind === "error") {
    return NextResponse.json(
      { error: result.kind === "error" ? translateConfirmReason(result.reasonCode) : result.kind, stage: "atomic_confirm", requestId },
      { status: statusForResult(result) },
    );
  }

  return NextResponse.json(
    { confirmation: result, stage: "atomic_confirm", requestId },
    { status: statusForResult(result) },
  );
}
