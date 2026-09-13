import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { validateTransactionHash } from "@/lib/nimiq/rpc";
import {
  createRewardSettlementService,
  resolvePollRewardSettlement,
} from "@/lib/rewards/settlement";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[reward-funding-bind]", { stage, ...data });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pollId: string; intentId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { pollId, intentId } = await params;

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", stage: "body", requestId, message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const rawHash = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).transactionHash === "string"
    ? (body as Record<string, string>).transactionHash
    : "";
  const transactionHash = validateTransactionHash(rawHash)?.toLowerCase();
  if (!transactionHash) {
    return NextResponse.json(
      { error: "invalid_hash", stage: "validation", requestId, message: "Invalid transaction hash format." },
      { status: 400 },
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
        error: settlement.kind === "not_found" ? "campaign_not_found" : "binding_failed",
        stage: "settlement",
        requestId,
        message: settlement.kind === "not_found"
          ? "Reward campaign not found."
          : "Could not resolve the reward settlement.",
      },
      { status: settlement.kind === "not_found" ? 404 : 500 },
    );
  }

  // This endpoint only binds the client callback. It intentionally does not
  // call getTransactionByHash or alter confirmed funding fields.
  const result = await createRewardSettlementService(admin).bindFunding(
    settlement.settlementId,
    intentId,
    funderWallet,
    transactionHash,
  );
  if (result.kind === "bound" || result.kind === "bound_replay") {
    return NextResponse.json(
      {
        binding: {
          fundingIntentId: intentId,
          campaignId: result.settlementId,
          transactionHash,
          status: "submitted",
        },
        campaignState: "funding_pending",
        resultKind: result.kind,
      },
      { status: result.kind === "bound" ? 201 : 200 },
    );
  }

  if (result.kind !== "error") return NextResponse.json(
    { error: "binding_failed", stage: "atomic_bind", requestId, message: "Could not bind this transaction hash." },
    { status: 500 },
  );

  const status = result.reasonCode === "forbidden" ? 403
    : result.reasonCode === "campaign_not_found" || result.reasonCode === "intent_not_found" ? 404
      : result.reasonCode === "invalid_hash" ? 400
        : result.reasonCode === "transaction_already_reserved" || result.reasonCode === "intent_already_bound" || result.reasonCode === "campaign_state_conflict" ? 409
          : 500;
  const error = result.reasonCode === "transaction_already_reserved"
    ? "transaction_already_reserved"
    : result.reasonCode === "intent_already_bound"
      ? "intent_already_bound"
      : result.reasonCode === "forbidden"
        ? "forbidden"
        : result.reasonCode === "intent_not_found"
          ? "intent_not_found"
          : "binding_failed";
  log("bind_rejected", { requestId, status, resultKind: result.reasonCode });
  return NextResponse.json(
    { error, stage: "atomic_bind", requestId, message: "Could not bind this transaction hash." },
    { status },
  );
}
