import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { validateTransactionHash } from "@/lib/nimiq/rpc";
import { bindCampaignFunding } from "@/lib/campaigns/funding";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-funding-bind]", { stage, ...data });
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

  // This endpoint only binds the client callback. It intentionally does not
  // observe the chain or alter confirmed funding fields.
  const result = await bindCampaignFunding(admin, campaignId, intentId, funderWallet, transactionHash);
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

  // Source-neutral engine codes translate onto the already-shipped statuses;
  // the shared engine never emits Campaign wording.
  const status = result.reasonCode === "forbidden" || result.reasonCode === "funding_not_allowed" ? 403
    : result.reasonCode === "campaign_not_found" || result.reasonCode === "intent_not_found" ||
      result.reasonCode === "settlement_not_found" || result.reasonCode === "source_not_supported" ? 404
      : result.reasonCode === "invalid_hash" ? 400
        : result.reasonCode === "transaction_already_reserved" || result.reasonCode === "intent_already_bound" ||
          result.reasonCode === "campaign_state_conflict" || result.reasonCode === "funding_conflict" ? 409
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
