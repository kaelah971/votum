import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import {
  createDefaultRefundReconciliationDependencies,
  loadRefundReconciliationContext,
  reconcileRefund,
} from "@/lib/rewards/refund-reconciliation";

export const runtime = "nodejs";

function statusForResult(result: Awaited<ReturnType<typeof reconcileRefund>>): number {
  if (result.kind === "confirmed" || result.kind === "replay") return 200;
  if (result.kind === "reconciled") {
    if (result.decision.status === "retryable") return 503;
    if (result.decision.status === "rejected") return 422;
    return 200;
  }
  if (result.kind === "busy" || result.kind === "not_confirmable") return 409;
  return 500;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pollId: string; refundId: string }> },
): Promise<NextResponse> {
  const { pollId, refundId } = await params;
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const viewerWallet = normalizeAddress(session.address);
  if (!viewerWallet) {
    return NextResponse.json(
      { error: "session_invalid", message: "Session wallet address is invalid." },
      { status: 401 },
    );
  }

  if (!getAdminConfigStatus().configured) {
    return NextResponse.json(
      { error: "service_unavailable", message: "Server not configured." },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  const loaded = await loadRefundReconciliationContext(admin, pollId, refundId, viewerWallet);
  if (loaded.kind !== "ok") {
    const status = loaded.kind === "forbidden"
      ? 403
      : loaded.kind === "not_found"
        ? 404
        : 500;
    return NextResponse.json(
      { error: loaded.kind === "error" ? loaded.reasonCode : loaded.kind },
      { status },
    );
  }

  const result = await reconcileRefund(
    loaded.context,
    createDefaultRefundReconciliationDependencies(admin),
  );
  return NextResponse.json(
    { reconciliation: result },
    { status: statusForResult(result) },
  );
}
