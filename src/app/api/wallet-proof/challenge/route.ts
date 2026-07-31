import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest, getServerOrigin } from "@/lib/api/origin";

export const runtime = "nodejs";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Production-safe structured logger.
 * Uses `console.error` so output is always visible in both `npm run dev`
 * and `npm run start` — never gated on NODE_ENV.
 *
 * NEVER log wallet addresses, nonces, signatures, or secrets.
 */
function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[wallet-proof]", { stage, ...data });
  }
}

/**
 * POST /api/wallet-proof/challenge
 *
 * Creates a cryptographic challenge message that the caller must sign
 * with their Nimiq wallet to prove address ownership.
 *
 * Body: { address: string }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");

  log("route_reached", { requestId });

  // ── 1. Origin validation ──────────────────────────────────────────────
  const origin = request.headers.get("origin") ?? "missing";
  log("origin_validation", { requestId, origin });

  if (!isSameOriginRequest(request)) {
    log("origin_rejected", { requestId, origin, status: 403 });
    return NextResponse.json(
      {
        error: "invalid_origin",
        stage: "origin_validation",
        requestId,
        message: "Cross-origin requests are not allowed.",
      },
      { status: 403 },
    );
  }

  // ── 2. Admin config ───────────────────────────────────────────────────
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    log("admin_unconfigured", {
      requestId,
      reason: adminConfig.reason,
      status: 503,
    });
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_config",
        requestId,
        message: "The server is not fully configured yet.",
      },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    log("admin_client_null", { requestId, status: 503 });
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin_client",
        requestId,
        message: "Could not initialise admin client.",
      },
      { status: 503 },
    );
  }

  // ── 3. Body parsing ───────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
    log("body_parsed", { requestId });
  } catch {
    log("body_parse_failed", { requestId, status: 400 });
    return NextResponse.json(
      {
        error: "bad_request",
        stage: "body_parsing",
        requestId,
        message: "Request body must be valid JSON.",
      },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("address" in body) ||
    typeof (body as Record<string, unknown>).address !== "string"
  ) {
    log("body_validation_failed", { requestId, status: 400 });
    return NextResponse.json(
      {
        error: "bad_request",
        stage: "body_validation",
        requestId,
        message: "Missing or invalid 'address' field.",
      },
      { status: 400 },
    );
  }

  const rawAddress = (body as Record<string, string>).address;
  log("address_received", { requestId, length: rawAddress.length });

  // ── 4. Address normalisation ──────────────────────────────────────────
  const address = normalizeAddress(rawAddress);
  if (!address) {
    log("address_normalisation_failed", { requestId, status: 400 });
    return NextResponse.json(
      {
        error: "invalid_address",
        stage: "address_normalisation",
        requestId,
        message: "The provided Nimiq address is not valid.",
      },
      { status: 400 },
    );
  }
  log("address_normalised", { requestId });

  // ── 5. Challenge generation ───────────────────────────────────────────
  const nonce = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const serverOrigin = getServerOrigin();
  const challengeOrigin = serverOrigin ?? "localhost";

  const message = [
    "Votum wallet verification",
    "",
    `Domain: ${challengeOrigin}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued at: ${now.toISOString()}`,
    `Expires at: ${expiresAt.toISOString()}`,
    "",
    "This request proves control of this Nimiq address.",
    "It does not send NIM or approve future payments.",
  ].join("\n");
  log("challenge_generated", { requestId, messageLength: message.length });

  // ── 6. Expire unused challenges for this wallet ──────────────────────
  // Mark any dangling challenges as used so they cannot be replayed.
  try {
    await admin
      .from("wallet_challenges")
      .update({ used_at: now.toISOString() })
      .eq("wallet_address", address)
      .is("used_at", null);
    log("old_challenges_expired", { requestId });
  } catch (e) {
    log("old_challenges_expire_failed", { requestId, error: String(e) });
  }

  // ── 7. Persist challenge ─────────────────────────────────────────────
  const { data: challenge, error } = await admin
    .from("wallet_challenges")
    .insert({
      wallet_address: address,
      message,
      origin: challengeOrigin,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (error || !challenge) {
    log("challenge_insert_failed", {
      requestId,
      status: 500,
      code: error?.code,
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
    });
    return NextResponse.json(
      {
        error: "challenge_insert_failed",
        stage: "challenge_insert",
        requestId,
        message: "Could not create the wallet verification challenge.",
      },
      { status: 500 },
    );
  }

  log("challenge_created", { requestId });

  // ── 8. Respond ───────────────────────────────────────────────────────
  return NextResponse.json({
    challengeId: challenge.id,
    message,
    expiresAt: expiresAt.toISOString(),
  });
}
