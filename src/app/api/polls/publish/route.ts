import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { nimDecimalToLuna } from "@/lib/nimiq/units";
import { isPollCategory, isPollFormat } from "@/lib/polls/taxonomy";

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
  dbMode: string;
  canonicalWallet: string;
  destinationPurpose: string;
  minNimLuna: bigint;
  fairnessMode: string;
  days: number;
  duration: string;
  options: string[];
  idempotencyKey: string;
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

  // ── mode (creator / community → creator_support / community_support)
  const rawMode = typeof body.mode === "string" ? body.mode : "";
  const dbMode =
    rawMode === "creator"
      ? "creator_support"
      : rawMode === "community"
        ? "community_support"
        : rawMode;
  if (!VALID_MODES.includes(dbMode)) {
    errors.push({ field: "mode", message: "Invalid contribution mode." });
  }

  // ── destinationWallet (Nimiq address, normalised to canonical hex)
  const destinationWallet =
    typeof body.destinationWallet === "string" ? body.destinationWallet : "";
  const canonicalWallet = normalizeAddress(destinationWallet);
  if (!canonicalWallet) {
    errors.push({
      field: "destinationWallet",
      message: "Invalid Nimiq wallet address.",
    });
  }

  // ── destinationPurpose ─────────────────────────────────────────────
  const purpose =
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
  let luna: bigint | null = null;
  try {
    luna = nimDecimalToLuna(minimumNim);
  } catch {
    errors.push({ field: "minimumNim", message: "Invalid minimum NIM amount." });
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
    },
  };
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
  const creatorWallet = session.address;
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
  const validation = validatePayload(body as Record<string, unknown>);
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
  const fingerprintPayload = {
    category: d.category,
    format: d.format,
    question: d.question,
    description: d.description,
    options: d.options,
    mode: d.dbMode,
    destinationWallet: d.canonicalWallet,
    destinationPurpose: d.destinationPurpose,
    minimumNimLuna: String(d.minNimLuna),
    fairnessMode: d.fairnessMode,
    duration: d.duration,
  };
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
        _min_nim_luna: Number(d.minNimLuna),
        _fairness_mode: d.fairnessMode,
        _ends_at: endsAt,
        _options: d.options,
        _idempotency_key: d.idempotencyKey,
        _request_fingerprint: requestFingerprint,
        _category: d.category,
        _format: d.format,
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
