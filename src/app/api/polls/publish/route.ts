import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { nimDecimalToLuna } from "@/lib/nimiq/units";
import { isPollCategory, isPollFormat } from "@/lib/polls/taxonomy";
import { validateRewardConfigInput } from "@/lib/rewards/config";
import { ensureCampaignVault } from "@/lib/rewards/vault-service";
import {
  LEGACY_SUPPORT_ENABLED,
  NEW_REWARD_FIRST_POLL,
  isPollEconomicModel,
  isRewardFirstMode,
  isRewardFundingMode,
  type PollEconomicModel,
  type RewardFirstMode,
  type RewardFundingMode,
} from "@/lib/polls/economic-model";

export const runtime = "nodejs";

// ── Constants ────────────────────────────────────────────────────────

const DURATION_DAYS: Record<string, number> = {
  "1day": 1,
  "3days": 3,
  "7days": 7,
  "14days": 14,
};

const VALID_MODES = ["creator_support", "community_support"];
const VALID_FAIRNESS = ["one_wallet_one_vote"];

const MAX_QUESTION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PURPOSE_LENGTH = 500;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_OPTION_LABEL_LENGTH = 120;
const MAX_BODY_BYTES = 64_000;

// ── Structured logging ───────────────────────────────────────────────

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[publish]", { stage, ...data });
  }
}

// ── Validation helpers ────────────────────────────────────────────────

interface FieldError {
  field: string;
  message: string;
}

interface ValidatedPayload {
  category: string;
  format: string;
  question: string;
  description: string | null;
  economicModel: PollEconomicModel;
  rewardMode: RewardFirstMode | null;
  dbMode: string | null;
  canonicalWallet: string | null;
  destinationPurpose: string | null;
  minNimLuna: bigint | null;
  fairnessMode: string;
  days: number;
  duration: string;
  options: string[];
  idempotencyKey: string;
  /** Optional rewarded-participation configuration (validated, immutable terms). */
  reward: ValidatedRewardConfigPayload | null;
}

interface ValidatedRewardConfigPayload {
  fundingMode?: RewardFundingMode;
  fundingWallet?: string;
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
}

/**
 * Validate and coerce the incoming JSON body into a typed payload.
 *
 * All validations mirror the database CHECK constraints so we catch
 * bad data early and return a structured field-level error response
 * before touching the database.
 */
function validatePayload(
  body: Record<string, unknown>,
  creatorWallet: string,
): { valid: true; data: ValidatedPayload } | { valid: false; errors: FieldError[] } {
  const errors: FieldError[] = [];

  // ── question ──────────────────────────────────────────────────────
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    errors.push({ field: "question", message: "Question is required." });
  } else if (question.length < 10) {
    errors.push({ field: "question", message: "Question must be at least 10 characters." });
  } else if (question.length > MAX_QUESTION_LENGTH) {
    errors.push({
      field: "question",
      message: `Question must be at most ${MAX_QUESTION_LENGTH} characters.`,
    });
  }

  // ── description (optional) ────────────────────────────────────────
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      field: "description",
      message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
  }

  // ── category (required, validated against canonical set) ─────────
  const rawCategory = typeof body.category === "string" ? body.category : "";
  const category =
    rawCategory === ""
      ? "communities" // backward compatible: missing → default
      : isPollCategory(rawCategory)
        ? rawCategory
        : "";
  if (rawCategory !== "" && !isPollCategory(rawCategory)) {
    errors.push({ field: "category", message: "Invalid poll category." });
  }

  // ── format (required, validated against canonical set) ──────────
  const rawFormat = typeof body.format === "string" ? body.format : "";
  const format =
    rawFormat === ""
      ? "decision" // backward compatible: missing → default
      : isPollFormat(rawFormat)
        ? rawFormat
        : "";
  if (rawFormat !== "" && !isPollFormat(rawFormat)) {
    errors.push({ field: "format", message: "Invalid participation format." });
  }

  const rawEconomicModel = body.economicModel;
  const economicModel: PollEconomicModel =
    rawEconomicModel === undefined || rawEconomicModel === null
      ? LEGACY_SUPPORT_ENABLED
      : isPollEconomicModel(rawEconomicModel)
        ? rawEconomicModel
        : LEGACY_SUPPORT_ENABLED;
  if (
    rawEconomicModel !== undefined &&
    rawEconomicModel !== null &&
    !isPollEconomicModel(rawEconomicModel)
  ) {
    errors.push({ field: "economicModel", message: "Invalid poll economic model." });
  }

  let rewardMode: RewardFirstMode | null = null;
  let dbMode: string | null = null;
  let canonicalWallet: string | null = null;
  let purpose: string | null = null;
  let luna: bigint | null = null;

  if (economicModel === LEGACY_SUPPORT_ENABLED) {
    // ── mode (creator / community → creator_support / community_support)
    const rawMode = typeof body.mode === "string" ? body.mode : "";
    dbMode =
      rawMode === "creator"
        ? "creator_support"
        : rawMode === "community"
          ? "community_support"
          : rawMode;
    if (dbMode === null || !VALID_MODES.includes(dbMode)) {
      errors.push({ field: "mode", message: "Invalid contribution mode." });
    }

    // ── destinationWallet (Nimiq address, normalised to canonical hex)
    const destinationWallet =
      typeof body.destinationWallet === "string" ? body.destinationWallet : "";
    canonicalWallet = normalizeAddress(destinationWallet);
    if (!canonicalWallet) {
      errors.push({
        field: "destinationWallet",
        message: "Invalid Nimiq wallet address.",
      });
    }

    // ── destinationPurpose ───────────────────────────────────────────
    purpose =
      typeof body.destinationPurpose === "string"
        ? body.destinationPurpose.trim()
        : "";
    if (!purpose) {
      errors.push({ field: "destinationPurpose", message: "Contribution purpose is required." });
    } else if (purpose.length > MAX_PURPOSE_LENGTH) {
      errors.push({
        field: "destinationPurpose",
        message: `Purpose must be at most ${MAX_PURPOSE_LENGTH} characters.`,
      });
    }

    // ── minimumNim (decimal string → bigint luna via nimDecimalToLuna) ─
    const minimumNim = typeof body.minimumNim === "string" ? body.minimumNim : "";
    try {
      luna = nimDecimalToLuna(minimumNim);
    } catch {
      errors.push({ field: "minimumNim", message: "Invalid minimum NIM amount." });
    }
    if (body.rewardMode !== undefined && body.rewardMode !== null) {
      errors.push({ field: "rewardMode", message: "Legacy support polls cannot set a reward mode." });
    }
  } else {
    rewardMode = isRewardFirstMode(body.rewardMode) ? body.rewardMode : null;
    if (!rewardMode) {
      errors.push({ field: "rewardMode", message: "Reward-first polls require free or rewarded mode." });
    }

    const supportFields = [
      "mode",
      "destinationWallet",
      "destinationPurpose",
      "minimumNim",
    ];
    for (const field of supportFields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        errors.push({ field, message: "Participant support fields are not allowed on reward-first polls." });
      }
    }
  }

  // ── fairnessMode (only one_wallet_one_vote for now) ───────────────
  const fairnessMode =
    typeof body.fairnessMode === "string"
      ? body.fairnessMode
      : "one_wallet_one_vote";
  if (!VALID_FAIRNESS.includes(fairnessMode)) {
    errors.push({ field: "fairnessMode", message: "Unsupported fairness mode." });
  }

  // ── duration (1day / 3days / 7days / 14days) ──────────────────────
  const duration = typeof body.duration === "string" ? body.duration : "";
  const days = DURATION_DAYS[duration];
  if (!days) {
    errors.push({ field: "duration", message: "Invalid poll duration." });
  }

  // ── options (2-6 unique non-empty labels, max 120 chars each) ─────
  const options = Array.isArray(body.options) ? body.options : [];
  if (options.length < MIN_OPTIONS) {
    errors.push({
      field: "options",
      message: `At least ${MIN_OPTIONS} options are required.`,
    });
  } else if (options.length > MAX_OPTIONS) {
    errors.push({
      field: "options",
      message: `Maximum ${MAX_OPTIONS} options allowed.`,
    });
  } else {
    const trimmed = options.map((o: unknown) => (typeof o === "string" ? o.trim() : ""));
    if (trimmed.some((o) => !o)) {
      errors.push({ field: "options", message: "Option labels cannot be empty." });
    } else {
      const maxLen = Math.max(...trimmed.map((o) => o.length));
      if (maxLen > MAX_OPTION_LABEL_LENGTH) {
        errors.push({
          field: "options",
          message: `Option labels must be at most ${MAX_OPTION_LABEL_LENGTH} characters.`,
        });
      }
      const lower = trimmed.map((o) => o.toLowerCase());
      if (new Set(lower).size !== lower.length) {
        errors.push({
          field: "options",
          message: "Duplicate option labels are not allowed.",
        });
      }
    }
  }

  // ── idempotencyKey (UUID v4 format) ───────────────────────────────
  const idempotencyKey =
    typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  ) {
    errors.push({
      field: "idempotencyKey",
      message: "Missing or invalid idempotency key.",
    });
  }

  // ── reward configuration ──────────────────────────────────────────
  let reward: ValidatedRewardConfigPayload | null = null;
  const hasRewardKey = Object.prototype.hasOwnProperty.call(body, "reward");
  const rewardRaw = isRecord(body.reward) ? body.reward : undefined;
  if (hasRewardKey && body.reward !== null && rewardRaw === undefined) {
    errors.push({ field: "reward", message: "Reward configuration must be an object." });
  }
  if (economicModel === NEW_REWARD_FIRST_POLL && rewardMode === "free" && rewardRaw) {
    errors.push({ field: "reward", message: "Free polls cannot include reward configuration." });
  }
  if (economicModel === NEW_REWARD_FIRST_POLL && rewardMode === "rewarded" && !rewardRaw) {
    errors.push({ field: "reward", message: "Rewarded polls require reward configuration." });
  }
  if (rewardRaw !== undefined && (economicModel === LEGACY_SUPPORT_ENABLED || rewardMode === "rewarded")) {
    const fundingMode =
      economicModel === LEGACY_SUPPORT_ENABLED
        ? "creator"
        : isRewardFundingMode(rewardRaw.fundingMode)
          ? rewardRaw.fundingMode
          : undefined;
    if (!fundingMode) {
      errors.push({ field: "rewardFundingMode", message: "Select who will fund the reward budget." });
    }

    let fundingWallet: string | undefined;
    const rawFundingWallet =
      typeof rewardRaw.fundingWallet === "string" ? rewardRaw.fundingWallet.trim() : "";
    if (fundingMode === "community") {
      fundingWallet = normalizeAddress(rawFundingWallet) ?? undefined;
      if (!fundingWallet) {
        errors.push({ field: "fundingWallet", message: "A valid designated funding wallet is required." });
      }
    } else if (rawFundingWallet) {
      fundingWallet = normalizeAddress(rawFundingWallet) ?? undefined;
      if (!fundingWallet || fundingWallet.toLowerCase() !== creatorWallet.toLowerCase()) {
        errors.push({ field: "fundingWallet", message: "Creator funding must use the verified creator wallet." });
      }
    }

    const rewardValidation = validateRewardConfigInput({
      rewardPerParticipant:
        typeof rewardRaw.rewardPerParticipant === "string"
          ? rewardRaw.rewardPerParticipant
          : "",
      maxRewardedParticipants:
        typeof rewardRaw.maxRewardedParticipants === "number"
          ? rewardRaw.maxRewardedParticipants
          : Number.NaN,
    });
    if (!rewardValidation.ok || !rewardValidation.value) {
      errors.push({
        field: "reward",
        message: "Invalid reward configuration.",
      });
    } else {
      reward = {
        ...(fundingMode ? { fundingMode } : {}),
        ...(fundingWallet ? { fundingWallet } : {}),
        rewardPerParticipantLuna: rewardValidation.value.rewardPerParticipantLuna,
        maxRewardedParticipants: rewardValidation.value.maxRewardedParticipants,
        rewardPrincipalLuna: rewardValidation.value.rewardPrincipalLuna,
        feeReserveLuna: rewardValidation.value.feeReserveLuna,
        totalBudgetLuna: rewardValidation.value.totalBudgetLuna,
      };
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    data: {
      category,
      format,
      question,
      description: description || null,
      dbMode,
      canonicalWallet: canonicalWallet!, // assured by validation above
      destinationPurpose: purpose,
      minNimLuna: luna!, // assured by validation above
      fairnessMode,
      days: days!, // assured by validation above
      duration, // raw duration key for fingerprint
      options: options.map((o: unknown) => String(o).trim()),
      idempotencyKey,
      reward,
      economicModel,
      rewardMode,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Route handler ─────────────────────────────────────────────────────

export async function POST(request: Request) {
  const requestId = randomBytes(8).toString("hex");
  const origin = request.headers.get("origin") ?? "missing";
  log("route_reached", { requestId, origin });

  // 1. Session check — must have a verified wallet session cookie
  const session = await getVerifiedWalletSession();
  if (!session) {
    log("session_missing", { requestId, status: 401 });
    return NextResponse.json(
      {
        error: "session_missing",
        stage: "session",
        requestId,
        message: "A verified wallet session is required.",
      },
      { status: 401 },
    );
  }
  const creatorWallet = normalizeAddress(session.address);
  if (!creatorWallet) {
    return NextResponse.json(
      {
        error: "session_invalid",
        stage: "session",
        requestId,
        message: "Session wallet address is invalid.",
      },
      { status: 401 },
    );
  }
  log("session_valid", { requestId });

  // 2. Content-Type must be application/json
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    return NextResponse.json(
      {
        error: "unsupported_media_type",
        stage: "content_type",
        requestId,
        message: "Content-Type must be application/json.",
      },
      { status: 415 },
    );
  }

  // 3. Body size limit
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        stage: "body_size",
        requestId,
        message: "Request body too large.",
      },
      { status: 413 },
    );
  }

  // 4. Parse JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_json",
        stage: "body_parse",
        requestId,
        message: "Request body must be valid JSON.",
      },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      {
        error: "invalid_json",
        stage: "body_parse",
        requestId,
        message: "Request body must be a JSON object.",
      },
      { status: 400 },
    );
  }

  // 5. Validate all fields
  const validation = validatePayload(body as Record<string, unknown>, creatorWallet);
  if (!validation.valid) {
    log("validation_failed", {
      requestId,
      status: 400,
      count: validation.errors.length,
    });
    return NextResponse.json(
      {
        error: "validation_failed",
        stage: "validation",
        requestId,
        message: "Invalid poll data.",
        fieldErrors: validation.errors,
      },
      { status: 400 },
    );
  }
  const d = validation.data;
  log("validation_passed", { requestId });

  // 6. Build request fingerprint for content-aware idempotency
  const fingerprintPayload: Record<string, unknown> = {
    category: d.category,
    format: d.format,
    question: d.question,
    description: d.description,
    options: d.options,
    mode: d.dbMode,
    destinationWallet: d.canonicalWallet,
    destinationPurpose: d.destinationPurpose,
    minimumNimLuna: d.minNimLuna === null ? null : String(d.minNimLuna),
    fairnessMode: d.fairnessMode,
    duration: d.duration,
  };
  if (d.economicModel === NEW_REWARD_FIRST_POLL) {
    fingerprintPayload.economicModel = d.economicModel;
    fingerprintPayload.rewardMode = d.rewardMode;
  }
  // Preserve the legacy fingerprint for reward-off requests. Reward-enabled
  // requests include their economic terms so the idempotency key is content-bound.
  if (d.reward) {
    fingerprintPayload.reward = {
      rewardPerParticipantLuna: String(d.reward.rewardPerParticipantLuna),
      maxRewardedParticipants: d.reward.maxRewardedParticipants,
      ...(d.economicModel === NEW_REWARD_FIRST_POLL
        ? {
            fundingMode: d.reward.fundingMode,
            fundingWallet: d.reward.fundingWallet ?? creatorWallet,
          }
        : {}),
    };
  }
  const fingerprintJson = JSON.stringify(
    fingerprintPayload,
    Object.keys(fingerprintPayload).sort(),
  );
  const requestFingerprint = createHash("sha256")
    .update(fingerprintJson)
    .digest("hex");

  // 7. Admin client availability
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_config",
        requestId,
        message: "Server not fully configured.",
      },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_client",
        requestId,
        message: "Admin client unavailable.",
      },
      { status: 503 },
    );
  }

  // 8. Calculate ends_at from duration
  const endsAt = new Date(
    Date.now() + d.days * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 9. Call the atomic database function
  try {
    // Note: min_nim_luna is stored as bigint in PostgreSQL. The value is
    // well within Number.MAX_SAFE_INTEGER for any realistic poll minimum
    // (the full 21 billion NIM supply = 2.1 quadrillion Luna < 9 quadrillion).
    const { data: result, error: rpcErr } = await admin.rpc(
      "publish_poll_atomic",
      {
        _creator_wallet: creatorWallet,
        _question: d.question,
        _description: d.description,
        _mode: d.dbMode,
        _destination_wallet: d.canonicalWallet,
        _destination_purpose: d.destinationPurpose,
        _min_nim_luna: d.minNimLuna === null ? null : Number(d.minNimLuna),
        _fairness_mode: d.fairnessMode,
        _ends_at: endsAt,
        _options: d.options,
        _idempotency_key: d.idempotencyKey,
        _request_fingerprint: requestFingerprint,
        _category: d.category,
        _format: d.format,
        _economic_model: d.economicModel,
        _reward_mode: d.rewardMode,
      },
    );

    if (rpcErr) {
      log("rpc_failed", {
        requestId,
        status: 500,
        code: rpcErr.code,
        message: rpcErr.message,
        details: rpcErr.details,
        hint: rpcErr.hint,
      });
      return NextResponse.json(
        {
          error: "publication_failed",
          stage: "rpc",
          requestId,
          message: "Could not publish the poll.",
        },
        { status: 500 },
      );
    }

    // The RPC returns { id, status, result_kind } for all three outcomes.
    // Conflicts are no longer raised as 23505 errors — they return a normal
    // JSON result with result_kind === "conflict".
    const pollResult = result as unknown as {
      id: string | null;
      status: string | null;
      result_kind: string;
    };

    if (pollResult.result_kind === "conflict") {
      return NextResponse.json(
        {
          error: "idempotency_conflict",
          stage: "idempotency",
          requestId,
          message:
            "This publication key has already been used for different poll content.",
        },
        { status: 409 },
      );
    }

    // 200 for idempotent replay, 201 for brand-new publication
    const isReplay = pollResult.result_kind === "replay";
    const status = isReplay ? 200 : 201;
    log("published", { requestId, status, result_kind: pollResult.result_kind });

    // Optional rewarded-participation configuration → create a `configured`
    // campaign (one per poll) + bind one vault. The reward is NOT advertised
    // as funded — the response carries `rewardFundingRequired` so the client
    // drives funding before the poll is presented as rewarded.
    let rewardResult: {
      rewardFundingRequired: boolean;
      campaignId: string | null;
      state: string | null;
      vaultAddressHex: string | null;
    } | null = null;

    if (pollResult.id && d.reward) {
      try {
        const { data: campaign } = await admin
          .from("reward_campaigns")
          .select("id, status")
          .eq("poll_id", pollResult.id)
          .maybeSingle();

        let campaignId: string;
        let campaignState: string;
        if (campaign) {
          campaignId = campaign.id;
          campaignState = campaign.status;
        } else {
          const { data: inserted, error: insErr } = await admin
            .from("reward_campaigns")
            .insert({
              poll_id: pollResult.id,
              creator_wallet: creatorWallet,
              funding_mode: d.reward.fundingMode ?? "creator",
              funding_wallet: d.reward.fundingWallet ?? creatorWallet,
              reward_per_participant_luna: Number(d.reward.rewardPerParticipantLuna),
              max_rewarded_participants: d.reward.maxRewardedParticipants,
              reward_principal_luna: Number(d.reward.rewardPrincipalLuna),
              fee_reserve_luna: Number(d.reward.feeReserveLuna),
              total_budget_luna: Number(d.reward.totalBudgetLuna),
              status: "configured",
            })
            .select("id, status")
            .single();
          if (insErr || !inserted) {
            throw new Error("reward_campaign_insert_failed");
          }
          campaignId = inserted.id;
          campaignState = inserted.status;
        }

        let vaultAddressHex: string | null = null;
        try {
          const vault = await ensureCampaignVault(campaignId);
          vaultAddressHex = vault.vaultAddressHex;
        } catch {
          // campaign exists; vault binding failed — surface as non-fatal flag
        }

        rewardResult = {
          rewardFundingRequired: campaignState !== "funded",
          campaignId,
          state: campaignState,
          vaultAddressHex,
        };
      } catch (err) {
        log("reward_config_failed", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json(
      {
        poll: {
          id: pollResult.id,
          status: pollResult.status,
          publishedAt: new Date().toISOString(),
          startsAt: new Date().toISOString(),
          endsAt,
        },
        resultKind: pollResult.result_kind,
        ...(rewardResult ? { reward: rewardResult } : {}),
      },
      { status },
    );
  } catch (err) {
    log("unexpected_error", {
      requestId,
      status: 500,
      error: String(err),
    });
    return NextResponse.json(
      {
        error: "publication_failed",
        stage: "rpc",
        requestId,
        message: "Could not publish the poll.",
      },
      { status: 500 },
    );
  }
}
