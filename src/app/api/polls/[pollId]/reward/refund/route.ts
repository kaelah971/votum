import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { createSupabaseRewardClosureService } from "@/lib/rewards/closure";
import {
  createSupabasePollClosureSourceStore,
  PollRewardClosureAdapter,
} from "@/lib/rewards/poll-closure-adapter";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>): void {
  const status = data.status;
  if (typeof status === "number" && status < 400 && process.env.NODE_ENV === "production") return;
  console.error("[reward-refund]", { stage, ...data });
}

function beginError(kind: string): { error: string; status: number; message: string } {
  switch (kind) {
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404, message: "Reward campaign not found." };
    case "forbidden":
      return { error: "forbidden", status: 403, message: "Only the campaign creator can request this refund." };
    case "campaign_not_closable":
    case "source_trigger_stale":
    case "participation_window_open":
    case "unresolved_reward_obligations":
    case "payout_reconciliation_required":
    case "invalid_reward_accounting":
      return { error: kind, status: 409, message: "The campaign is not ready for refund execution." };
    case "refund_state_conflict":
    case "refund_intent_missing":
      return { error: kind, status: 409, message: "The refund is not ready for execution." };
    case "campaign_lookup_failed":
      return { error: kind, status: 500, message: "Could not load the reward campaign." };
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

  const pollClosureAdapter = new PollRewardClosureAdapter(
    createSupabasePollClosureSourceStore(admin),
  );
  const closureContext = await pollClosureAdapter.resolveClosureContext(pollId, session.address);
  if (closureContext.kind !== "ready") {
    const mapped = closureContext.kind === "not_closed"
      ? beginError(closureContext.reasonCode)
      : closureContext.kind === "forbidden"
        ? beginError("forbidden")
        : closureContext.kind === "not_found"
          ? beginError("campaign_not_found")
          : beginError("campaign_lookup_failed");
    log("source_closure_rejected", { requestId, status: mapped.status, reasonCode: closureContext.kind });
    return NextResponse.json(
      { error: mapped.error, stage: "source", requestId, message: mapped.message },
      { status: mapped.status },
    );
  }

  // The body is intentionally ignored. The preparation RPC derives the
  // creator, vault, amount, and state from its locked database snapshot.
  const closureService = createSupabaseRewardClosureService(
    admin,
    pollClosureAdapter.revalidateTrigger.bind(pollClosureAdapter),
  );
  const prepared = await closureService.prepareRefund(
    closureContext.context,
    { sessionTokenHash: session.tokenHash },
  );
  if (prepared.kind === "nothing_to_refund" || prepared.kind === "already_refunded_or_closed") {
    return NextResponse.json(
      { resultKind: prepared.kind, campaignId: prepared.settlementId, requestId },
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
      { error: "refund_preparation_failed", stage: "response", requestId, message: "Refund preparation response was invalid." },
      { status: 500 },
    );
  }

  const execution = await closureService.executeRefund(prepared.settlementId, prepared.refundId);
  const status = executionStatus(execution.kind);
  log("execution_complete", { requestId, status, resultKind: execution.kind });
  return NextResponse.json(
    { refund: execution, preparationKind: prepared.kind, requestId },
    { status },
  );
}
