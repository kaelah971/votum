import { NextResponse } from "next/server";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import {
  normalizeAddress,
  deriveAddressFromPublicKey,
  verifyNimiqMiniAppSignature,
} from "@/lib/nimiq/server-crypto";
import { isSameOriginRequest } from "@/lib/api/origin";
import { randomBytes, createHash } from "node:crypto";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  const code = data.status;
  const isError = typeof code === "number" && code >= 400;
  if (process.env.NODE_ENV !== "production" || isError) {
    console.error("[wallet-verify]", { stage, ...data });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomBytes(8).toString("hex");
  log("route_reached", { requestId });

  // 1. Origin check
  if (!isSameOriginRequest(request)) {
    log("origin_rejected", { requestId, status: 403 });
    return NextResponse.json(
      { error: "invalid_origin", stage: "origin_check", requestId, message: "Cross-origin requests not allowed." },
      { status: 403 },
    );
  }

  // 2. Admin config
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    log("admin_unconfigured", { requestId, status: 503 });
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_config", requestId, message: "Server not fully configured." },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    log("admin_client_null", { requestId, status: 503 });
    return NextResponse.json(
      { error: "service_unavailable", stage: "admin_client", requestId, message: "Admin client unavailable." },
      { status: 503 },
    );
  }

  // 3. Parse body
  let body: unknown;
  try { body = await request.json(); } catch {
    log("body_parse_failed", { requestId, status: 400 });
    return NextResponse.json(
      { error: "bad_request", stage: "body_parse", requestId, message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const challengeId = typeof b.challengeId === "string" ? b.challengeId : "";
  const submittedAddress = typeof b.address === "string" ? b.address : "";
  const publicKeyHex = typeof b.publicKey === "string" ? b.publicKey : "";
  const signatureHex = typeof b.signature === "string" ? b.signature : "";

  if (!challengeId || !submittedAddress || !publicKeyHex || !signatureHex) {
    log("body_validation_failed", { requestId, status: 400 });
    return NextResponse.json(
      { error: "bad_request", stage: "body_validation", requestId, message: "Missing required fields." },
      { status: 400 },
    );
  }

  // 4. Load challenge
  const { data: challenge, error: fetchErr } = await admin
    .from("wallet_challenges")
    .select("*")
    .eq("id", challengeId)
    .single();

  if (fetchErr || !challenge) {
    log("challenge_not_found", { requestId, status: 400 });
    return NextResponse.json(
      { error: "challenge_not_found", stage: "challenge_load", requestId, message: "Verification challenge not found." },
      { status: 400 },
    );
  }

  // 5. Challenge expiry
  if (new Date(challenge.expires_at) < new Date()) {
    log("challenge_expired", { requestId, status: 400 });
    return NextResponse.json(
      { error: "challenge_expired", stage: "challenge_expiry", requestId, message: "This verification request has expired. Start again." },
      { status: 400 },
    );
  }

  // 6. Challenge already used
  if (challenge.used_at) {
    log("challenge_already_used", { requestId, status: 409 });
    return NextResponse.json(
      { error: "challenge_already_used", stage: "challenge_used_check", requestId, message: "This challenge has already been used." },
      { status: 409 },
    );
  }

  // 7. Canonicalize submitted address
  const submittedCanonical = normalizeAddress(submittedAddress);
  if (!submittedCanonical) {
    log("submitted_address_invalid", { requestId, status: 400 });
    return NextResponse.json(
      { error: "invalid_address", stage: "address_canonicalize", requestId, message: "The provided wallet address is not valid." },
      { status: 400 },
    );
  }

  // 8. Compare submitted address with challenge address (both canonical hex)
  if (submittedCanonical !== challenge.wallet_address) {
    log("submitted_address_mismatch", { requestId, status: 400 });
    return NextResponse.json(
      { error: "submitted_address_mismatch", stage: "submitted_address_check", requestId, message: "The selected wallet does not match this verification challenge." },
      { status: 400 },
    );
  }
  log("submitted_address_match", { requestId });

  // 9. Derive signer address from public key
  const signerCanonical = deriveAddressFromPublicKey(publicKeyHex);
  if (!signerCanonical) {
    log("public_key_invalid", { requestId, status: 400 });
    return NextResponse.json(
      { error: "invalid_public_key", stage: "public_key_parse", requestId, message: "The signing public key is not valid." },
      { status: 400 },
    );
  }

  // 10. Compare signer address with challenge address
  if (signerCanonical !== challenge.wallet_address) {
    log("signer_address_mismatch", { requestId, status: 400 });
    return NextResponse.json(
      { error: "signer_address_mismatch", stage: "signer_address_check", requestId, message: "The signing key does not belong to the selected wallet." },
      { status: 400 },
    );
  }
  log("signer_address_match", { requestId });

  // 11. Verify signature over the stored challenge message
  const sigValid = verifyNimiqMiniAppSignature(challenge.message, publicKeyHex, signatureHex);
  if (!sigValid) {
    log("signature_invalid", { requestId, status: 400 });
    return NextResponse.json(
      { error: "signature_verification_failed", stage: "signature_check", requestId, message: "The wallet signature could not be verified." },
      { status: 400 },
    );
  }
  log("signature_valid", { requestId });

  // 12. Atomically mark challenge used
  const { error: consumeErr, count } = await admin
    .from("wallet_challenges")
    .update({ used_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", challengeId)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString());

  if (consumeErr || (count ?? 0) !== 1) {
    log("challenge_consume_failed", { requestId, status: 409, count });
    return NextResponse.json(
      { error: "challenge_already_used", stage: "challenge_consume", requestId, message: "This challenge has already been used." },
      { status: 409 },
    );
  }
  log("challenge_consumed", { requestId });

  // 13. Create session
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const sessionExpires = new Date(Date.now() + 12 * 60 * 60 * 1000);

  const { error: sessionErr } = await admin
    .from("wallet_sessions")
    .insert({
      token_hash: tokenHash,
      wallet_address: signerCanonical,
      expires_at: sessionExpires.toISOString(),
    });

  if (sessionErr) {
    log("session_insert_failed", { requestId, status: 500, code: sessionErr.code, message: sessionErr.message });
    return NextResponse.json(
      { error: "session_error", stage: "session_insert", requestId, message: "Could not create verified session." },
      { status: 500 },
    );
  }
  log("session_created", { requestId });

  // 14. Set cookie
  const response = NextResponse.json({
    verified: true,
    walletAddress: submittedAddress,
  });

  const isSecure = process.env.NODE_ENV === "production" && !!process.env.NEXT_PUBLIC_APP_URL;
  response.cookies.set("votum_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: 60 * 60 * 12,
  });

  log("response_sent", { requestId, status: 200 });
  return response;
}
