import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { verifyCampaignClaimSignature } from "@/lib/campaigns/claim-challenge";
import {
  createCampaignRewardParticipationAdapter,
} from "@/lib/rewards/campaign-participation-adapter";
import { createSupabaseCampaignRewardParticipationStore } from "@/lib/campaigns/claim-participation-store";
import {
  createRewardReservationService,
  createSupabaseRewardReservationStore,
} from "@/lib/rewards/reservation-service";
import { createRewardSettlementService } from "@/lib/rewards/settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  if (typeof code === "number" && code < 400 && process.env.NODE_ENV === "production") return;
  console.error("[campaign-claim]", { stage, ...data });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Map an authoritative reservation rejection onto the shipped claim HTTP
 * vocabulary. Verification failures keep their exact codes; reservation
 * rejections keep their distinctions as reasonCodes. Only the terminal
 * capacity state uses 409; every other claim rejection is 422.
 */
function reservationRejection(reasonCode: string): { error: string; status: number; reason?: string } {
  switch (reasonCode) {
    case "challenge_invalid":
    case "challenge_expired":
    case "challenge_consumed":
      return { error: reasonCode, status: 422 };
    case "campaign_not_found":
      return { error: "campaign_not_found", status: 404 };
    case "unsupported_type":
      return { error: "claim_not_available", status: 422, reason: "unsupported_type" };
    case "campaign_not_published":
      return { error: "claim_not_available", status: 422, reason: "not_published" };
    case "campaign_closed":
      return { error: "claim_not_available", status: 422, reason: "closed" };
    case "claim_not_started":
      return { error: "claim_not_available", status: 422, reason: "not_started" };
    case "claim_ended":
      return { error: "claim_not_available", status: 422, reason: "ended" };
    case "campaign_not_funded":
      return { error: "claim_not_available", status: 422, reason: "funding_pending" };
    case "creator_not_eligible":
    case "creator_not_reward_eligible":
      return { error: "claim_not_available", status: 422, reason: "creator_ineligible" };
    case "no_reward_capacity":
      return { error: "claim_not_available", status: 409, reason: "sold_out" };
    default:
      return { error: "claim_not_available", status: 422, reason: reasonCode };
  }
}

/**
 * Post-commit payout handoff. Runs strictly after the reservation commit,
 * mirrors the Poll vote follow-up: invoke the existing automatic payout
 * path, log the outcome, and never fail the committed claim when payout
 * enqueue itself faults. No NIM moves in this route beyond delegating to
 * the unchanged settlement engine.
 */
async function handoffClaimPayout(
  admin: AdminClient,
  settlementId: string,
  receiptId: string,
  requestId: string,
): Promise<void> {
  try {
    const payout = await createRewardSettlementService(admin).executePayout(settlementId, receiptId);
    log("claim_payout", {
      requestId,
      status: 200,
      resultKind: (payout as { kind?: unknown }).kind ?? "unknown",
    });
  } catch (error) {
    log("claim_payout_failed", { requestId, status: 500, error: String(error) });
  }
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
  const sessionWallet = normalizeAddress(session.address);
  if (!sessionWallet) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", stage: "body", requestId },
      { status: 400 },
    );
  }
  const fields = (typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null);
  const challengeId = fields !== null && isNonEmptyString(fields.challengeId) ? fields.challengeId : null;
  const address = fields !== null && isNonEmptyString(fields.address) ? fields.address : null;
  const publicKey = fields !== null && isNonEmptyString(fields.publicKey) ? fields.publicKey : null;
  const signature = fields !== null && isNonEmptyString(fields.signature) ? fields.signature : null;
  if (!challengeId || !address || !publicKey || !signature) {
    return NextResponse.json(
      { error: "invalid_request", stage: "body", requestId },
      { status: 400 },
    );
  }

  // The session wallet must equal the signing wallet: a challenge issued
  // for wallet W never authorizes wallet X, even with a verified session.
  if (normalizeAddress(address) !== sessionWallet) {
    return NextResponse.json(
      { error: "wallet_mismatch", stage: "session", requestId },
      { status: 422 },
    );
  }

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
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

  // Cryptographic verification BEFORE mutation, using the V2C.3C library.
  // Verification only: it never writes consumed_at. Consumption authority
  // is deferred to the atomic claim transaction so exact retries of a
  // consumed challenge still reach M3's replay path.
  const verification = await verifyCampaignClaimSignature(admin, {
    challengeId,
    campaignId,
    address,
    publicKey,
    signature,
  }, { deferConsumedCheck: true });
  if (verification.kind === "error") {
    return NextResponse.json(
      { error: verification.reasonCode, stage: "challenge", requestId },
      { status: 422 },
    );
  }

  // Courtesy participation screen; the atomic RPC remains authoritative for
  // every mutation-time check.
  const adapter = createCampaignRewardParticipationAdapter(
    createSupabaseCampaignRewardParticipationStore(admin),
  );
  const participation = await adapter.resolveParticipation({
    campaignId,
    challengeId,
    verifiedSession: { address: sessionWallet },
  });
  if (participation.kind !== "eligible") {
    if (participation.reasonCode === "campaign_not_found") {
      return NextResponse.json(
        { error: "campaign_not_found", stage: "participation", requestId },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "claim_not_available", reasonCode: participation.reasonCode, stage: "participation", requestId },
      { status: 422 },
    );
  }

  // Exactly one mutation path: the authoritative atomic claim transaction.
  // The route performs no receipt, counter, capacity, or consumption writes.
  const reservation = await createRewardReservationService(
    createSupabaseRewardReservationStore(admin),
  ).reserve(participation.context);
  switch (reservation.kind) {
    case "reserved":
    case "replay": {
      // Post-commit handoff only: payout runs outside the reservation commit
      // and can never roll it back. Replay of a terminal receipt needs no payout.
      if (reservation.receiptStatus === "reserved" || reservation.receiptStatus === "payout_pending") {
        await handoffClaimPayout(admin, reservation.settlementId, reservation.receiptId, requestId);
      }

      return NextResponse.json(
        {
          receiptId: reservation.receiptId,
          settlementId: reservation.settlementId,
          status: reservation.receiptStatus,
          replayed: reservation.kind === "replay",
        },
        { status: 201 },
      );
    }
    case "rejected":
      log("claim_reservation_failed", { requestId, status: 500, reasonCode: reservation.reasonCode });
      return NextResponse.json(
        { error: "claim_failed", reasonCode: reservation.reasonCode, stage: "reservation", requestId },
        { status: 500 },
      );
    case "ineligible": {
      const mapped = reservationRejection(reservation.reasonCode);
      const bodyOut = mapped.reason === undefined
        ? { error: mapped.error, stage: "reservation", requestId }
        : { error: mapped.error, reasonCode: mapped.reason, stage: "reservation", requestId };
      return NextResponse.json(bodyOut, { status: mapped.status });
    }
  }
}
