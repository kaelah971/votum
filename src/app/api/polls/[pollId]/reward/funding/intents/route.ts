import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  createRewardSettlementService,
  resolvePollRewardSettlement,
} from "@/lib/rewards/settlement";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[reward-funding-intent]", { stage, ...data });
}

function resultError(
  resultKind: string,
  requestId: string,
): { error: string; status: number; message: string } {
  switch (resultKind) {
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404, message: "Reward campaign not found." };
    case "forbidden":
      return { error: "forbidden", status: 403, message: "Only the designated funding wallet can fund this campaign." };
    case "poll_not_public":
      return { error: "private_poll_not_rewardable", status: 422, message: "Reward campaigns are public polls only." };
    case "vault_missing":
      return { error: "vault_unavailable", status: 503, message: "The campaign vault is not available." };
    case "funding_amount_unsafe":
      return { error: "funding_amount_unsafe", status: 422, message: "The required funding amount cannot be represented safely by Nimiq Pay." };
    case "campaign_state_conflict":
      return { error: "campaign_state_conflict", status: 409, message: "This campaign cannot begin another funding attempt." };
    default:
      log("unknown_rpc_result", { requestId, status: 500, resultKind });
      return { error: "funding_intent_failed", status: 500, message: "Could not create a funding intent." };
  }
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

  const { data: poll, error: pollErr } = await admin
    .from("polls")
    .select("id, creator_wallet, is_public")
    .eq("id", pollId)
    .maybeSingle();
  if (pollErr || !poll) {
    return NextResponse.json(
      { error: "poll_not_found", stage: "poll", requestId, message: "Poll not found." },
      { status: 404 },
    );
  }
  if (!poll.is_public) {
    return NextResponse.json(
      { error: "private_poll_not_rewardable", stage: "public_only", requestId, message: "Reward campaigns are public polls only." },
      { status: 422 },
    );
  }

  const settlement = await resolvePollRewardSettlement(admin, pollId);
  if (settlement.kind !== "ok") {
    return NextResponse.json(
      {
        error: settlement.kind === "not_found" ? "campaign_not_found" : "funding_intent_failed",
        stage: "settlement",
        requestId,
        message: settlement.kind === "not_found"
          ? "Reward campaign not found."
          : "Could not resolve the reward settlement.",
      },
      { status: settlement.kind === "not_found" ? 404 : 500 },
    );
  }

  const result = await createRewardSettlementService(admin).beginFunding(
    settlement.settlementId,
    funderWallet,
  );
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
