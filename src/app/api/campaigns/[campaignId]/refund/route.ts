import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import {
  executeCampaignRefund,
  prepareCampaignRefund,
} from "@/lib/campaigns/refund";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-refund]", { stage, ...data });
}

function beginError(reasonCode: string): { error: string; status: number; message: string } {
  switch (reasonCode) {
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404, message: "Campaign not found." };
    case "forbidden":
      return { error: "forbidden", status: 403, message: "Only the Campaign owner can request this refund." };
    case "participation_window_open":
    case "campaign_not_closable":
    case "unresolved_reward_obligations":
    case "payout_reconciliation_required":
    case "invalid_reward_accounting":
      return { error: reasonCode, status: 409, message: "The campaign is not ready for refund execution." };
    case "refund_state_conflict":
    case "refund_intent_missing":
      return { error: reasonCode, status: 409, message: "The refund is not ready for execution." };
    default:
      return { error: "refund_preparation_failed", status: 500, message: "Could not prepare the campaign refund." };
  }
}

function executionStatus(kind: string): number {
  if (kind === "broadcasted" || kind === "already_pending") return 200;
  if (kind === "unknown") return 202;
  if (kind === "busy") return 409;
  if (kind === "retryable") return 503;
  return 409;
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
  const owner = normalizeAddress(session.address);
  if (!owner) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId },
      { status: 401 },
    );
  }

  if (!getAdminConfigStatus().configured) {
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

  // The request body carries no authority and is ignored. The preparation
  // RPC derives the campaign, owner, settlement, amount, recipient, and any
  // existing refund intent from its locked database snapshot.
  const prepared = await prepareCampaignRefund(
    admin,
    campaignId,
    owner,
    session.tokenHash,
  );
  if (prepared.kind === "nothing_to_refund" || prepared.kind === "already_refunded_or_closed") {
    return NextResponse.json(
      { status: "refunded", resultKind: prepared.kind, settlementId: prepared.settlementId, requestId },
      { status: 200 },
    );
  }
  if (prepared.kind === "error") {
    const mapped = beginError(prepared.reasonCode);
    log("preparation_rejected", { requestId, status: mapped.status, resultKind: prepared.reasonCode });
    return NextResponse.json(
      { error: mapped.error, stage: "atomic_begin", requestId, message: mapped.message },
      { status: mapped.status },
    );
  }
  if (prepared.kind !== "created" && prepared.kind !== "replay") {
    return NextResponse.json(
      { error: "refund_preparation_failed", stage: "response", requestId },
      { status: 500 },
    );
  }

  const execution = await executeCampaignRefund(admin, prepared.settlementId, prepared.refundId);
  const status = executionStatus(execution.kind);
  log("execution_complete", { requestId, status, resultKind: execution.kind });
  return NextResponse.json(
    {
      refundId: "refundId" in execution ? execution.refundId : prepared.refundId,
      status: execution.kind,
      transactionHash: "transactionHash" in execution ? execution.transactionHash : null,
      preparationKind: prepared.kind,
      requestId,
    },
    { status },
  );
}
