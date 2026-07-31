import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { nimDecimalToLuna } from "@/lib/nimiq/units";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  console.error("[support-intent]", { stage, ...data });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pollId: string }> },
) {
  const { pollId } = await params;
  const requestId = randomBytes(8).toString("hex");

  // 1. Session — must have a verified wallet session cookie
  const session = await getVerifiedWalletSession();
  if (!session) {
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
  const supporterWallet = session.address;

  // 2. Content-Type must be application/json
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    return NextResponse.json(
      {
        error: "invalid_json",
        stage: "content_type",
        requestId,
        message: "Content-Type must be application/json.",
      },
      { status: 400 },
    );
  }

  // 3. Parse JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "invalid_json",
        stage: "body_parse",
        requestId,
        message: "Invalid JSON.",
      },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const optionId = typeof b.optionId === "string" ? b.optionId : "";
  const amountNim = typeof b.amountNim === "string" ? b.amountNim : "";
  if (!optionId || !amountNim) {
    return NextResponse.json(
      {
        error: "validation_failed",
        stage: "validation",
        requestId,
        message: "optionId and amountNim are required.",
      },
      { status: 400 },
    );
  }

  // 4. Parse NIM amount to Luna
  let amountLuna: bigint;
  try {
    amountLuna = nimDecimalToLuna(amountNim);
  } catch (e: unknown) {
    return NextResponse.json(
      {
        error: "invalid_amount",
        stage: "validation",
        requestId,
        message: (e as Error).message,
      },
      { status: 400 },
    );
  }

  // Reject amounts that cannot be safely represented by the Mini App provider
  if (amountLuna > BigInt(Number.MAX_SAFE_INTEGER)) {
    return NextResponse.json({ error: "invalid_amount", stage: "validation", requestId, message: "Amount exceeds the maximum safe integer for Nimiq Pay." }, { status: 400 });
  }

  // 5. Admin client availability
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin",
        requestId,
        message: "Server not configured.",
      },
      { status: 503 },
    );
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        stage: "admin",
        requestId,
        message: "Admin client unavailable.",
      },
      { status: 503 },
    );
  }

  // 6. Validate poll (must exist, be live, not expired, not in the future)
  const { data: poll, error: pollErr } = await admin
    .from("polls")
    .select("id, status, is_public, starts_at, ends_at, min_nim_luna, destination_wallet")
    .eq("id", pollId)
    .single();

  if (pollErr || !poll) {
    return NextResponse.json(
      {
        error: "poll_not_found",
        stage: "poll",
        requestId,
        message: "Poll not found.",
      },
      { status: 404 },
    );
  }
  if (poll.status !== "live") {
    return NextResponse.json(
      {
        error: "poll_not_open",
        stage: "poll",
        requestId,
        message: "This poll is not accepting support.",
      },
      { status: 423 },
    );
  }
  if (amountLuna < BigInt(poll.min_nim_luna)) {
    return NextResponse.json(
      {
        error: "amount_below_minimum",
        stage: "validation",
        requestId,
        message: "Amount is below the poll minimum.",
      },
      { status: 400 },
    );
  }
  if (poll.starts_at && new Date(poll.starts_at) > new Date()) {
    return NextResponse.json(
      {
        error: "poll_not_open",
        stage: "poll",
        requestId,
        message: "Poll has not started.",
      },
      { status: 423 },
    );
  }
  if (new Date(poll.ends_at) <= new Date()) {
    return NextResponse.json(
      {
        error: "poll_not_open",
        stage: "poll",
        requestId,
        message: "Poll has ended.",
      },
      { status: 423 },
    );
  }

  // 7. Validate option belongs to this poll
  const { data: opt, error: optErr } = await admin
    .from("poll_options")
    .select("id")
    .eq("id", optionId)
    .eq("poll_id", pollId)
    .single();

  if (optErr || !opt) {
    return NextResponse.json(
      {
        error: "invalid_option",
        stage: "validation",
        requestId,
        message: "Option does not belong to this poll.",
      },
      { status: 422 },
    );
  }

  // 8. Generate support intent
  const reference = `votum:${randomBytes(16).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const supporterCanonical = normalizeAddress(supporterWallet) ?? supporterWallet;
  const recipientCanonical = normalizeAddress(poll.destination_wallet) ?? poll.destination_wallet;

  // nim_support_intents may not be in generated Database types — use `as any`
  const intentQuery = admin.from("nim_support_intents" as any) as any;
  const { data: intent, error: insertErr } = await intentQuery
    .insert({
      reference,
      poll_id: pollId,
      option_id: optionId,
      supporter_wallet: supporterCanonical,
      recipient_wallet: recipientCanonical,
      amount_luna: Number(amountLuna),
      memo: reference,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !intent) {
    log("insert_failed", {
      requestId,
      code: insertErr?.code,
      message: insertErr?.message,
    });
    return NextResponse.json(
      {
        error: "intent_failed",
        stage: "insert",
        requestId,
        message: "Could not create support intent.",
      },
      { status: 500 },
    );
  }

  log("intent_created", { requestId });
  return NextResponse.json(
    {
      intent: {
        id: intent.id,
        recipient: poll.destination_wallet,
        valueLuna: amountLuna.toString(),
        memo: reference,
        expiresAt: expiresAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
