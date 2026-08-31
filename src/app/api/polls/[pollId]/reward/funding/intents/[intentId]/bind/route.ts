import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { validateTransactionHash } from "@/lib/nimiq/rpc";

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

  const { data: campaign, error: campaignErr } = await admin
    .from("reward_campaigns")
    .select("id, funding_wallet")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campaignErr || !campaign) {
    return NextResponse.json(
      { error: "campaign_not_found", stage: "campaign", requestId, message: "Reward campaign not found." },
      { status: 404 },
    );
  }
  if (campaign.funding_wallet.toLowerCase() !== funderWallet.toLowerCase()) {
    return NextResponse.json(
      { error: "forbidden", stage: "funding_wallet", requestId, message: "Only the designated funding wallet can bind funding." },
      { status: 403 },
    );
  }

  // This endpoint only binds the client callback. It intentionally does not
  // call getTransactionByHash or alter confirmed funding fields.
  const { data: rawResult, error: rpcErr } = await admin.rpc("bind_reward_funding_transaction_atomic", {
    _campaign_id: campaign.id,
    _intent_id: intentId,
    _funder_wallet: funderWallet,
    _transaction_hash: transactionHash,
  });
  if (rpcErr) {
    log("bind_rpc_failed", { requestId, status: 500, code: rpcErr.code, message: rpcErr.message });
    return NextResponse.json(
      { error: "binding_failed", stage: "atomic_bind", requestId, message: "Could not bind the transaction hash." },
      { status: 500 },
    );
  }

  const result = rawResult as Record<string, unknown>;
  const resultKind = typeof result.result_kind === "string" ? result.result_kind : "";
  if (resultKind === "bound" || resultKind === "bound_replay") {
    return NextResponse.json(
      {
        binding: {
          fundingIntentId: intentId,
          campaignId: campaign.id,
          transactionHash,
          status: "submitted",
        },
        campaignState: "funding_pending",
        resultKind,
      },
      { status: resultKind === "bound" ? 201 : 200 },
    );
  }

  const status = resultKind === "forbidden" ? 403
    : resultKind === "campaign_not_found" || resultKind === "intent_not_found" ? 404
      : resultKind === "invalid_hash" ? 400
        : resultKind === "transaction_already_reserved" || resultKind === "intent_already_bound" || resultKind === "campaign_state_conflict" ? 409
          : 500;
  const error = resultKind === "transaction_already_reserved"
    ? "transaction_already_reserved"
    : resultKind === "intent_already_bound"
      ? "intent_already_bound"
      : resultKind === "forbidden"
        ? "forbidden"
        : resultKind === "intent_not_found"
          ? "intent_not_found"
          : "binding_failed";
  log("bind_rejected", { requestId, status, resultKind });
  return NextResponse.json(
    { error, stage: "atomic_bind", requestId, message: "Could not bind this transaction hash." },
    { status },
  );
}
