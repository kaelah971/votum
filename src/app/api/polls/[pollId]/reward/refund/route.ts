import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { executeRewardRefund } from "@/lib/rewards/refund";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type RpcResult = Record<string, unknown>;

function log(stage: string, data: Record<string, unknown>): void {
  const status = data.status;
  if (typeof status === "number" && status < 400 && process.env.NODE_ENV === "production") return;
  console.error("[reward-refund]", { stage, ...data });
}

function resultKind(data: unknown): string {
  return typeof data === "object" && data !== null && typeof (data as RpcResult).result_kind === "string"
    ? (data as RpcResult).result_kind as string
    : "";
}

function beginError(kind: string): { error: string; status: number; message: string } {
  switch (kind) {
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404, message: "Reward campaign not found." };
    case "forbidden":
      return { error: "forbidden", status: 403, message: "Only the campaign creator can request this refund." };
    case "campaign_not_closable":
    case "unresolved_reward_obligations":
    case "payout_reconciliation_required":
    case "invalid_reward_accounting":
      return { error: kind, status: 409, message: "The campaign is not ready for refund execution." };
    case "refund_state_conflict":
    case "refund_intent_missing":
      return { error: kind, status: 409, message: "The refund is not ready for execution." };
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
  _request: Request,
  { params }: { params: Promise<{ pollId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { pollId } = await params;

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }
  if (!normalizeAddress(session.address)) {
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

  const { data: campaign, error: campaignError } = await admin
    .from("reward_campaigns")
    .select("id")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campaignError) {
    log("campaign_lookup_failed", { requestId, status: 500, code: campaignError.code });
    return NextResponse.json(
      { error: "campaign_lookup_failed", stage: "campaign", requestId, message: "Could not load the reward campaign." },
      { status: 500 },
    );
  }
  if (!campaign) {
    return NextResponse.json(
      { error: "campaign_not_found", stage: "campaign", requestId, message: "Reward campaign not found." },
      { status: 404 },
    );
  }

  // The body is intentionally ignored. The preparation RPC derives the
  // creator, vault, amount, and state from its locked database snapshot.
  const { data: prepared, error: preparationError } = await admin.rpc("begin_reward_refund_atomic", {
    _campaign_id: campaign.id,
    _session_token_hash: session.tokenHash,
  });
  if (preparationError) {
    log("preparation_rpc_failed", { requestId, status: 500, code: preparationError.code });
    return NextResponse.json(
      { error: "refund_preparation_failed", stage: "atomic_begin", requestId, message: "Could not prepare the campaign refund." },
      { status: 500 },
    );
  }

  const preparationKind = resultKind(prepared);
  if (preparationKind === "nothing_to_refund" || preparationKind === "already_refunded_or_closed") {
    return NextResponse.json(
      { resultKind: preparationKind, campaignId: campaign.id, requestId },
      { status: 200 },
    );
  }
  if (preparationKind !== "created" && preparationKind !== "replay") {
    const mapped = beginError(preparationKind);
    log("preparation_rejected", { requestId, status: mapped.status, resultKind: preparationKind });
    return NextResponse.json(
      { error: mapped.error, stage: "atomic_begin", requestId, message: mapped.message },
      { status: mapped.status },
    );
  }

  const refundId = typeof (prepared as RpcResult).refund_id === "string"
    ? (prepared as RpcResult).refund_id as string
    : null;
  if (!refundId) {
    log("preparation_shape_invalid", { requestId, status: 500, resultKind: preparationKind });
    return NextResponse.json(
      { error: "refund_preparation_failed", stage: "response", requestId, message: "Refund preparation response was invalid." },
      { status: 500 },
    );
  }

  const execution = await executeRewardRefund(admin, refundId, campaign.id);
  const status = executionStatus(execution.kind);
  log("execution_complete", { requestId, status, resultKind: execution.kind });
  return NextResponse.json(
    { refund: execution, preparationKind, requestId },
    { status },
  );
}
