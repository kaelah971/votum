import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { mapFundingIntentResult } from "@/lib/rewards/funding";

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
      return { error: "forbidden", status: 403, message: "Only the campaign creator can fund this campaign." };
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
  const creatorWallet = normalizeAddress(session.address);
  if (!creatorWallet) {
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
  if (poll.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
    log("not_owner", { requestId, status: 403 });
    return NextResponse.json(
      { error: "forbidden", stage: "ownership", requestId, message: "Only the poll creator can fund this campaign." },
      { status: 403 },
    );
  }
  if (!poll.is_public) {
    return NextResponse.json(
      { error: "private_poll_not_rewardable", stage: "public_only", requestId, message: "Reward campaigns are public polls only." },
      { status: 422 },
    );
  }

  const { data: campaign, error: campaignErr } = await admin
    .from("reward_campaigns")
    .select("id, poll_id")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campaignErr || !campaign) {
    return NextResponse.json(
      { error: "campaign_not_found", stage: "campaign", requestId, message: "Reward campaign not found." },
      { status: 404 },
    );
  }

  const { data: rawResult, error: rpcErr } = await admin.rpc("begin_reward_funding_atomic", {
    _campaign_id: campaign.id,
    _creator_wallet: creatorWallet,
  });
  if (rpcErr) {
    log("begin_rpc_failed", { requestId, status: 500, code: rpcErr.code, message: rpcErr.message });
    return NextResponse.json(
      { error: "funding_intent_failed", stage: "atomic_begin", requestId, message: "Could not create a funding intent." },
      { status: 500 },
    );
  }

  const result = rawResult as Record<string, unknown>;
  const resultKind = typeof result.result_kind === "string" ? result.result_kind : "";
  if (resultKind !== "created" && resultKind !== "replay") {
    const mapped = resultError(resultKind, requestId);
    return NextResponse.json(
      { error: mapped.error, stage: "atomic_begin", requestId, message: mapped.message },
      { status: mapped.status },
    );
  }

  const fundingIntent = mapFundingIntentResult(result);
  if (!fundingIntent) {
    log("invalid_rpc_shape", { requestId, status: 500 });
    return NextResponse.json(
      { error: "funding_intent_failed", stage: "response", requestId, message: "Funding intent response was invalid." },
      { status: 500 },
    );
  }

  log("intent_ready", { requestId, status: resultKind === "created" ? 201 : 200 });
  return NextResponse.json(
    {
      fundingIntent,
      campaignState: "funding_pending",
      resultKind,
    },
    { status: resultKind === "created" ? 201 : 200 },
  );
}
