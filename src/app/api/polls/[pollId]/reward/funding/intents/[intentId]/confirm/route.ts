import { NextResponse } from "next/server";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import {
  createRewardSettlementService,
  resolvePollRewardSettlement,
  type RewardSettlementService,
} from "@/lib/rewards/settlement";

export const runtime = "nodejs";

function statusForResult(result: Awaited<ReturnType<RewardSettlementService["confirmFunding"]>>): number {
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

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pollId: string; intentId: string }> },
): Promise<NextResponse> {
  const { pollId, intentId } = await params;
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const funderWallet = normalizeAddress(session.address);
  if (!funderWallet) {
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

  const settlement = await resolvePollRewardSettlement(admin, pollId);
  if (settlement.kind !== "ok") {
    return NextResponse.json(
      { error: settlement.kind === "not_found" ? "campaign_not_found" : "database_read_failed" },
      { status: settlement.kind === "not_found" ? 404 : 500 },
    );
  }

  const result = await createRewardSettlementService(admin).confirmFunding(
    settlement.settlementId,
    intentId,
    funderWallet,
  );
  if (result.kind === "forbidden" || result.kind === "not_found" || result.kind === "error") {
    return NextResponse.json(
      { error: result.kind === "error" ? result.reasonCode : result.kind },
      { status: statusForResult(result) },
    );
  }

  return NextResponse.json(
    { confirmation: result },
    { status: statusForResult(result) },
  );
}
