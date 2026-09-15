import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { getAdminConfigStatus, createAdminClient } from "@/lib/supabase/admin";
import {
  validateRewardConfigInput,
  assertConfigMutable,
} from "@/lib/rewards/config";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { lunaToNim } from "@/lib/nimiq/units";
import { addressesEqual, normalizeAddress, toUserFriendlyAddress } from "@/lib/nimiq/server-crypto";
import { isRewardFundingMode, type RewardFundingMode } from "@/lib/polls/economic-model";

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
  funding_mode: RewardFundingMode;
  funding_wallet: string;
  reward_per_participant_luna: number;
  max_rewarded_participants: number;
  reward_principal_luna: number;
  fee_reserve_luna: number;
  total_budget_luna: number;
  status: string;
  vault_wallet: string | null;
}

interface FundingSummaryRow {
  id: string;
  campaign_id: string;
  reference: string;
  amount_luna: number;
  reward_principal_luna: number | null;
  fee_reserve_luna: number | null;
  status: string;
  submitted_transaction_hash: string | null;
  confirmation_deadline: string | null;
  created_at: string;
}

interface PollSummaryRow {
  id: string;
  question: string;
  economic_model: string | null;
  reward_mode: string | null;
}

/**
 * Creator-only campaign configuration summary. Safe outward shape — no
 * ciphertext, IV, auth tag, envelope, or key material.
 */
function toConfigSummary(
  campaign: CampaignRow,
  vaultAddressHex: string | null,
  funding: FundingSummaryRow | null = null,
  poll?: PollSummaryRow,
) {
  return {
    campaignId: campaign.id,
    pollId: campaign.poll_id,
    pollQuestion: poll?.question ?? null,
    economicModel: poll?.economic_model === "reward_first" ? "reward_first" : "legacy_support",
    rewardMode:
      poll?.economic_model === "reward_first" &&
      (poll.reward_mode === "free" || poll.reward_mode === "rewarded")
        ? poll.reward_mode
        : null,
    state: campaign.status,
    fundingMode: campaign.funding_mode,
    fundingWallet: campaign.funding_wallet,
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
    vaultAddressNq: vaultAddressHex ? toUserFriendlyAddress(vaultAddressHex) : null,
    funding: funding
      ? {
          fundingIntentId: funding.id,
          campaignId: funding.campaign_id,
          reference: funding.reference,
          status: funding.status,
          amountLuna: String(funding.amount_luna),
          rewardPrincipalLuna: funding.reward_principal_luna === null
            ? null
            : String(funding.reward_principal_luna),
          feeReserveLuna: funding.fee_reserve_luna === null
            ? null
            : String(funding.fee_reserve_luna),
          submittedTransactionHash: funding.submitted_transaction_hash,
          confirmationDeadline: funding.confirmation_deadline,
          createdAt: funding.created_at,
        }
      : null,
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
  const sessionWallet = normalizeAddress(session.address);
  if (!sessionWallet) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId, message: "Session wallet address is invalid." },
      { status: 401 },
    );
  }

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
    .select("id, creator_wallet, is_public, question, economic_model, reward_mode")
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
  if (!addressesEqual(poll.creator_wallet, sessionWallet)) {
    log("not_owner", { requestId, status: 403 });
    return NextResponse.json(
      { error: "forbidden", stage: "ownership", requestId, message: "Only the poll creator can configure rewards." },
      { status: 403 },
    );
  }

  if (poll.economic_model !== "reward_first" || poll.reward_mode !== "rewarded") {
    log("poll_not_rewardable", { requestId, status: 422 });
    return NextResponse.json(
      { error: "poll_not_rewardable", stage: "economic_model", requestId, message: "Only rewarded reward-first polls can configure rewards." },
      { status: 422 },
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
      ? (body as {
          rewardPerParticipant?: unknown;
          maxRewardedParticipants?: unknown;
          fundingMode?: unknown;
          fundingWallet?: unknown;
        })
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

  if (
    rewardInput.fundingMode !== undefined &&
    !isRewardFundingMode(rewardInput.fundingMode)
  ) {
    return NextResponse.json(
      { error: "validation_failed", stage: "funding", requestId, message: "Invalid funding mode.", fieldErrors: [{ field: "fundingMode", message: "Choose creator or community funding." }] },
      { status: 400 },
    );
  }
  const fundingMode: RewardFundingMode = isRewardFundingMode(rewardInput.fundingMode)
    ? rewardInput.fundingMode
    : "creator";
  const rawFundingWallet =
    typeof rewardInput.fundingWallet === "string"
      ? rewardInput.fundingWallet.trim()
      : "";
  let fundingWallet = sessionWallet;
  if (fundingMode === "community") {
    const designatedWallet = normalizeAddress(rawFundingWallet);
    if (!designatedWallet) {
      return NextResponse.json(
        { error: "validation_failed", stage: "funding", requestId, message: "A valid designated funding wallet is required.", fieldErrors: [{ field: "fundingWallet", message: "Enter a valid designated funding wallet." }] },
        { status: 400 },
      );
    }
    fundingWallet = designatedWallet;
  } else if (rawFundingWallet) {
    const requestedWallet = normalizeAddress(rawFundingWallet);
    if (!requestedWallet || requestedWallet !== sessionWallet) {
      return NextResponse.json(
        { error: "validation_failed", stage: "funding", requestId, message: "Creator funding must use the verified creator wallet.", fieldErrors: [{ field: "fundingWallet", message: "Creator funding must use the verified creator wallet." }] },
        { status: 400 },
      );
    }
  }

  // Load the Poll adapter (if any) to enforce immutability and one-per-poll.
  const { data: existing } = await admin
    .from("reward_campaigns")
    .select("id, status, poll_id, settlement_id")
    .eq("poll_id", pollId)
    .maybeSingle();

  if (existing) {
    const { data: binding, error: bindingError } = await admin
      .from("settlement_source_bindings")
      .select("settlement_id, source_type, reward_campaign_id")
      .eq("reward_campaign_id", existing.id)
      .maybeSingle();
    if (
      bindingError ||
      !binding ||
      binding.source_type !== "poll_reward_campaign" ||
      binding.reward_campaign_id !== existing.id ||
      binding.settlement_id !== existing.settlement_id
    ) {
      return NextResponse.json(
        { error: "settlement_binding_invalid", stage: "authority", requestId, message: "The reward settlement binding is unavailable." },
        { status: 500 },
      );
    }
  }

  let campaignId: string;
  let settlementId: string;

  if (existing) {
    if (typeof existing.settlement_id !== "string") {
      return NextResponse.json(
        { error: "settlement_missing", stage: "authority", requestId, message: "The reward settlement is unavailable." },
        { status: 500 },
      );
    }
    const { data: root, error: rootError } = await admin
      .from("reward_settlements")
      .select("status")
      .eq("id", existing.settlement_id)
      .maybeSingle();
    if (rootError || !root) {
      return NextResponse.json(
        { error: "settlement_missing", stage: "authority", requestId, message: "The reward settlement is unavailable." },
        { status: 500 },
      );
    }
    // Terms mutable only while the settlement is `configured`.
    try {
      assertConfigMutable(root.status as never);
    } catch {
      log("terms_locked", { requestId, status: 409, state: root.status });
      return NextResponse.json(
        { error: "terms_immutable", stage: "immutability", requestId, message: "Reward terms are locked once funding begins." },
        { status: 409 },
      );
    }
    campaignId = existing.id;
    settlementId = existing.settlement_id;
  } else {
    campaignId = "";
    settlementId = "";
  }

  const { data: authority, error: authorityError } = await admin.rpc(
    "ensure_poll_reward_settlement_atomic",
    {
      _poll_id: pollId,
      _creator_wallet: sessionWallet,
      _funding_mode: fundingMode,
      _funding_wallet: fundingWallet,
      _reward_per_participant_luna: Number(v.rewardPerParticipantLuna),
      _max_rewarded_participants: v.maxRewardedParticipants,
      _reward_principal_luna: Number(v.rewardPrincipalLuna),
      _fee_reserve_luna: Number(v.feeReserveLuna),
      _total_budget_luna: Number(v.totalBudgetLuna),
    },
  );
  const authorityRow = authority && typeof authority === "object"
    ? authority as { result_kind?: string; campaign_id?: string; settlement_id?: string; status?: string }
    : null;
  if (
    authorityError ||
    !authorityRow ||
    !authorityRow.campaign_id ||
    !authorityRow.settlement_id ||
    !["created", "updated"].includes(authorityRow.result_kind ?? "")
  ) {
    if (authorityRow?.result_kind === "terms_locked") {
      return NextResponse.json(
        { error: "terms_immutable", stage: "immutability", requestId, message: "Reward terms are locked once funding begins." },
        { status: 409 },
      );
    }
    if (authorityRow?.result_kind === "forbidden") {
      return NextResponse.json(
        { error: "forbidden", stage: "authority", requestId, message: "Only the poll creator can configure rewards." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "authority_failed", stage: "authority", requestId, message: "Could not create the reward settlement." },
      { status: 500 },
    );
  }
  campaignId = authorityRow.campaign_id;
  settlementId = authorityRow.settlement_id;

  // Bind one vault (idempotent; safe metadata only).
  let vaultAddressHex: string | null = null;
  try {
    const vault = await ensureRewardSettlementVault(settlementId);
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
  const { data: finalRoot, error: rootReadErr } = await admin
    .from("reward_settlements")
    .select("*")
    .eq("id", settlementId)
    .maybeSingle();
  if (readErr || rootReadErr || !finalCampaign || !finalRoot) {
      return NextResponse.json(
        { error: "read_failed", stage: "authority", requestId, message: "Could not read the reward settlement." },
        { status: 500 },
      );
  }

  const campaignView = {
    ...finalCampaign,
    funding_mode: finalRoot.funding_mode,
    funding_wallet: finalRoot.funding_wallet,
    reward_per_participant_luna: finalRoot.reward_per_participant_luna,
    max_rewarded_participants: finalRoot.max_rewarded_participants,
    reward_principal_luna: finalRoot.reward_principal_luna,
    fee_reserve_luna: finalRoot.fee_reserve_luna,
    total_budget_luna: finalRoot.total_budget_luna,
    status: finalRoot.status,
  } as CampaignRow;
  log("configured", { requestId, status: 200, campaignId, settlementId, state: campaignView.status });
  return NextResponse.json({
    config: toConfigSummary(
      campaignView,
      vaultAddressHex,
      null,
      poll as unknown as PollSummaryRow,
    ),
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
  const sessionWallet = normalizeAddress(session.address);
  if (!sessionWallet) {
    return NextResponse.json(
      { error: "session_invalid", stage: "session", requestId, message: "Session wallet address is invalid." },
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
    .select("id, creator_wallet, question, economic_model, reward_mode")
    .eq("id", pollId)
    .maybeSingle();
  if (pollErr || !poll) {
    return NextResponse.json(
      { error: "poll_not_found", stage: "poll", requestId, message: "Poll not found." },
      { status: 404 },
    );
  }
  if (!addressesEqual(poll.creator_wallet, sessionWallet)) {
    return NextResponse.json(
      { error: "forbidden", stage: "ownership", requestId, message: "Only the poll creator can view reward configuration." },
      { status: 403 },
    );
  }
  if (poll.economic_model !== "reward_first" || poll.reward_mode !== "rewarded") {
    return NextResponse.json(
      { error: "poll_not_rewardable", stage: "economic_model", requestId, message: "Only rewarded reward-first polls have reward configuration." },
      { status: 422 },
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

  const { data: binding, error: bindingErr } = await admin
    .from("settlement_source_bindings")
    .select("settlement_id, source_type, reward_campaign_id")
    .eq("reward_campaign_id", campaign.id)
    .maybeSingle();
  if (
    bindingErr ||
    !binding ||
    binding.source_type !== "poll_reward_campaign" ||
    binding.reward_campaign_id !== campaign.id ||
    binding.settlement_id !== campaign.settlement_id
  ) {
    return NextResponse.json(
      { error: "settlement_binding_invalid", stage: "authority", requestId, message: "The reward settlement binding is unavailable." },
      { status: 500 },
    );
  }

  const settlementId = typeof campaign.settlement_id === "string"
    ? campaign.settlement_id
    : null;
  if (!settlementId) {
    return NextResponse.json(
      { error: "settlement_missing", stage: "authority", requestId, message: "The reward settlement is unavailable." },
      { status: 500 },
    );
  }

  const { data: root, error: rootErr } = await admin
    .from("reward_settlements")
    .select("*")
    .eq("id", settlementId)
    .maybeSingle();
  if (rootErr || !root) {
    return NextResponse.json(
      { error: "settlement_missing", stage: "authority", requestId, message: "The reward settlement is unavailable." },
      { status: 500 },
    );
  }

  let vaultAddressHex: string | null = null;
  const { data: vault } = await admin
    .from("reward_campaign_vaults")
    .select("vault_address_hex")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (vault) {
    vaultAddressHex = (vault as { vault_address_hex: string }).vault_address_hex;
  }

  const { data: funding } = await admin
    .from("reward_funding_transactions")
    .select(
      "id, campaign_id, reference, amount_luna, reward_principal_luna, fee_reserve_luna, status, submitted_transaction_hash, confirmation_deadline, created_at",
    )
    .eq("settlement_id", settlementId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    config: toConfigSummary(
      {
        ...campaign,
        funding_mode: root.funding_mode,
        funding_wallet: root.funding_wallet,
        reward_per_participant_luna: root.reward_per_participant_luna,
        max_rewarded_participants: root.max_rewarded_participants,
        reward_principal_luna: root.reward_principal_luna,
        fee_reserve_luna: root.fee_reserve_luna,
        total_budget_luna: root.total_budget_luna,
        status: root.status,
        settlement_id: settlementId,
      } as unknown as CampaignRow,
      vaultAddressHex,
      (funding as FundingSummaryRow | null) ?? null,
      poll as unknown as PollSummaryRow,
    ),
  });
}
