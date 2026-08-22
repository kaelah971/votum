import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { getAdminConfigStatus, createAdminClient } from "@/lib/supabase/admin";
import {
  validateRewardConfigInput,
  assertConfigMutable,
} from "@/lib/rewards/config";
import { ensureCampaignVault } from "@/lib/rewards/vault-service";
import { lunaToNim } from "@/lib/nimiq/units";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[reward-config]", { stage, ...data });
  }
}

interface CampaignRow {
  id: string;
  poll_id: string;
  creator_wallet: string;
  reward_per_participant_luna: number;
  max_rewarded_participants: number;
  reward_principal_luna: number;
  fee_reserve_luna: number;
  total_budget_luna: number;
  status: string;
  vault_wallet: string | null;
}

/**
 * Creator-only campaign configuration summary. Safe outward shape — no
 * ciphertext, IV, auth tag, envelope, or key material.
 */
function toConfigSummary(campaign: CampaignRow, vaultAddressHex: string | null) {
  return {
    campaignId: campaign.id,
    pollId: campaign.poll_id,
    state: campaign.status,
    rewardPerParticipant: {
      luna: String(campaign.reward_per_participant_luna),
      nim: lunaToNim(BigInt(campaign.reward_per_participant_luna)),
    },
    maxRewardedParticipants: campaign.max_rewarded_participants,
    rewardPrincipal: {
      luna: String(campaign.reward_principal_luna),
      nim: lunaToNim(BigInt(campaign.reward_principal_luna)),
    },
    feeReserve: {
      luna: String(campaign.fee_reserve_luna),
      nim: lunaToNim(BigInt(campaign.fee_reserve_luna)),
    },
    totalRequiredFunding: {
      luna: String(campaign.total_budget_luna),
      nim: lunaToNim(BigInt(campaign.total_budget_luna)),
    },
    vaultAddressHex,
    funded: false, // configuration only — never advertised as funded until chain confirmation
  };
}

/**
 * POST /api/polls/[pollId]/reward/config
 *
 * Authorized creator reward configuration for a PUBLIC poll. Creates or updates
 * the `configured` campaign (one per poll) with immutable economic terms, and
 * binds one vault. Returns only the safe creator read model.
 *
 * - no session → 401
 * - non-owner → 403
 * - poll missing → 404
 * - private poll → 422 (clean domain rejection)
 * - reward input invalid → 400
 * - terms locked (state beyond `configured`) → 409
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ pollId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { pollId } = await context.params;

  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }
  const sessionWallet = session.address;

  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_config", requestId, message: "Server not fully configured." },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_client", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  // Poll must exist and be PUBLIC.
  const { data: poll, error: pollErr } = await admin
    .from("polls")
    .select("id, creator_wallet, is_public")
    .eq("id", pollId)
    .maybeSingle();
  if (pollErr) {
    return NextResponse.json(
      { error: "poll_lookup_failed", stage: "poll", requestId, message: "Could not load the poll." },
      { status: 500 },
    );
  }
  if (!poll) {
    return NextResponse.json(
      { error: "poll_not_found", stage: "poll", requestId, message: "Poll not found." },
      { status: 404 },
    );
  }
  if (!poll.is_public) {
    log("private_poll_rejected", { requestId, status: 422 });
    return NextResponse.json(
      { error: "private_poll_not_rewardable", stage: "public_only", requestId, message: "Reward campaigns are public polls only." },
      { status: 422 },
    );
  }

  // Creator wallet must come from the session (must equal poll.creator_wallet).
  // The request body may NEVER choose the wallet.
  if (poll.creator_wallet.toLowerCase() !== sessionWallet.toLowerCase()) {
    log("not_owner", { requestId, status: 403 });
    return NextResponse.json(
      { error: "forbidden", stage: "ownership", requestId, message: "Only the poll creator can configure rewards." },
      { status: 403 },
    );
  }

  // Parse + validate reward config.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", stage: "body", requestId, message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const rewardInput =
    typeof body === "object" && body !== null
      ? (body as { rewardPerParticipant?: unknown; maxRewardedParticipants?: unknown })
      : {};
  const validation = validateRewardConfigInput({
    rewardPerParticipant:
      typeof rewardInput.rewardPerParticipant === "string"
        ? rewardInput.rewardPerParticipant
        : "",
    maxRewardedParticipants:
      typeof rewardInput.maxRewardedParticipants === "number"
        ? rewardInput.maxRewardedParticipants
        : Number.NaN,
  });
  if (!validation.ok || !validation.value) {
    log("validation_failed", { requestId, status: 400, count: validation.errors.length });
    return NextResponse.json(
      { error: "validation_failed", stage: "validation", requestId, message: "Invalid reward configuration.", fieldErrors: validation.errors },
      { status: 400 },
    );
  }
  const v = validation.value;

  // Load existing campaign (if any) to enforce immutability and one-per-poll.
  const { data: existing } = await admin
    .from("reward_campaigns")
    .select("id, status, poll_id")
    .eq("poll_id", pollId)
    .maybeSingle();

  let campaignId: string;

  if (existing) {
    // Terms mutable only while `configured`.
    try {
      assertConfigMutable(existing.status as never);
    } catch {
      log("terms_locked", { requestId, status: 409, state: existing.status });
      return NextResponse.json(
        { error: "terms_immutable", stage: "immutability", requestId, message: "Reward terms are locked once funding begins." },
        { status: 409 },
      );
    }
    campaignId = existing.id;
    const { error: updErr } = await admin
      .from("reward_campaigns")
      .update({
        reward_per_participant_luna: Number(v.rewardPerParticipantLuna),
        max_rewarded_participants: v.maxRewardedParticipants,
        reward_principal_luna: Number(v.rewardPrincipalLuna),
        fee_reserve_luna: Number(v.feeReserveLuna),
        total_budget_luna: Number(v.totalBudgetLuna),
      })
      .eq("id", campaignId);
    if (updErr) {
      return NextResponse.json(
        { error: "update_failed", stage: "campaign", requestId, message: "Could not update the reward campaign." },
        { status: 500 },
      );
    }
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("reward_campaigns")
      .insert({
        poll_id: pollId,
        creator_wallet: sessionWallet,
        reward_per_participant_luna: Number(v.rewardPerParticipantLuna),
        max_rewarded_participants: v.maxRewardedParticipants,
        reward_principal_luna: Number(v.rewardPrincipalLuna),
        fee_reserve_luna: Number(v.feeReserveLuna),
        total_budget_luna: Number(v.totalBudgetLuna),
        status: "configured",
      })
      .select("id, status")
      .single();
    if (insErr || !inserted) {
      return NextResponse.json(
        { error: "insert_failed", stage: "campaign", requestId, message: "Could not create the reward campaign." },
        { status: 500 },
      );
    }
    campaignId = inserted.id;
  }

  // Bind one vault (idempotent; safe metadata only).
  let vaultAddressHex: string | null = null;
  try {
    const vault = await ensureCampaignVault(campaignId);
    vaultAddressHex = vault.vaultAddressHex;
  } catch (err) {
    log("vault_bind_failed", {
      requestId,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "vault_unavailable", stage: "vault", requestId, message: "Could not prepare the campaign reward vault." },
      { status: 500 },
    );
  }

  const { data: finalCampaign, error: readErr } = await admin
    .from("reward_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (readErr || !finalCampaign) {
    return NextResponse.json(
      { error: "read_failed", stage: "campaign", requestId, message: "Could not read the reward campaign." },
      { status: 500 },
    );
  }

  log("configured", { requestId, status: 200, campaignId, state: finalCampaign.status });
  return NextResponse.json({
    config: toConfigSummary(finalCampaign as unknown as CampaignRow, vaultAddressHex),
  });
}

/**
 * GET /api/polls/[pollId]/reward/config
 *
 * Creator-only read model of the campaign configuration (safe shape). 404 when
 * the poll has no reward campaign. Never returns ciphertext / IV / auth tag /
 * envelope / key material.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ pollId: string }> },
): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  const { pollId } = await context.params;

  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json(
      { error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." },
      { status: 401 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_client", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  const { data: poll, error: pollErr } = await admin
    .from("polls")
    .select("id, creator_wallet")
    .eq("id", pollId)
    .maybeSingle();
  if (pollErr || !poll) {
    return NextResponse.json(
      { error: "poll_not_found", stage: "poll", requestId, message: "Poll not found." },
      { status: 404 },
    );
  }
  if (poll.creator_wallet.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json(
      { error: "forbidden", stage: "ownership", requestId, message: "Only the poll creator can view reward configuration." },
      { status: 403 },
    );
  }

  const { data: campaign, error: campErr } = await admin
    .from("reward_campaigns")
    .select("*")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campErr) {
    return NextResponse.json(
      { error: "read_failed", stage: "campaign", requestId, message: "Could not read the reward campaign." },
      { status: 500 },
    );
  }
  if (!campaign) {
    return NextResponse.json(
      { error: "reward_config_missing", stage: "campaign", requestId, message: "No reward campaign is configured for this poll." },
      { status: 404 },
    );
  }

  let vaultAddressHex: string | null = null;
  const { data: vault } = await admin
    .from("reward_campaign_vaults")
    .select("vault_address_hex")
    .eq("campaign_id", (campaign as { id: string }).id)
    .maybeSingle();
  if (vault) {
    vaultAddressHex = (vault as { vault_address_hex: string }).vault_address_hex;
  }

  return NextResponse.json({
    config: toConfigSummary(campaign as unknown as CampaignRow, vaultAddressHex),
  });
}
