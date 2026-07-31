import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { getTransactionByHash } from "@/lib/nimiq/rpc";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  console.error("[support-confirm]", { stage, ...data });
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
  const intentId = typeof b.intentId === "string" ? b.intentId : "";
  const txHash = typeof b.transactionHash === "string" ? b.transactionHash : "";
  if (!intentId || !txHash) {
    return NextResponse.json(
      {
        error: "validation_failed",
        stage: "validation",
        requestId,
        message: "intentId and transactionHash are required.",
      },
      { status: 400 },
    );
  }

  // 4. Admin client availability
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

  // 5. Load intent and validate ownership
  // nim_support_intents not in generated Database types — cast to `any`
  const intentQuery = admin.from("nim_support_intents" as any) as any;
  const { data: rawIntent, error: intentErr } = await intentQuery
    .select("*")
    .eq("id", intentId)
    .single();
  const intent = rawIntent as Record<string, unknown> | null;

  if (intentErr || !intent) {
    return NextResponse.json(
      {
        error: "intent_not_found",
        stage: "intent",
        requestId,
        message: "Support intent not found.",
      },
      { status: 404 },
    );
  }
  if (intent.poll_id !== pollId) {
    return NextResponse.json(
      {
        error: "intent_not_found",
        stage: "intent",
        requestId,
        message: "Intent does not belong to this poll.",
      },
      { status: 404 },
    );
  }
  if (
    intent.status === "expired" ||
    new Date(intent.expires_at as string) <= new Date()
  ) {
    return NextResponse.json(
      {
        error: "intent_expired",
        stage: "intent",
        requestId,
        message: "This support intent has expired.",
      },
      { status: 410 },
    );
  }
  const supporterCanonical =
    normalizeAddress(supporterWallet) ?? supporterWallet;
  if (intent.supporter_wallet !== supporterCanonical) {
    return NextResponse.json(
      {
        error: "intent_not_found",
        stage: "intent",
        requestId,
        message: "Intent does not belong to this wallet.",
      },
      { status: 404 },
    );
  }

  // 6. Fetch and verify on-chain transaction
  const txResult = await getTransactionByHash(txHash);
  if ("error" in txResult) {
    if (txResult.error === "not_found") {
      return NextResponse.json(
        {
          error: "transaction_pending",
          stage: "rpc",
          requestId,
          message: "Transaction not yet included. Try again in a moment.",
          retryable: true,
        },
        { status: 202 },
      );
    }
    return NextResponse.json(
      {
        error: "rpc_unavailable",
        stage: "rpc",
        requestId,
        message: "Could not verify the transaction.",
      },
      { status: 502 },
    );
  }
  const tx = txResult.data;

  // 7. Verify transaction details match the intent
  const txSender = normalizeAddress(tx.from) ?? tx.from;
  const txRecipient = normalizeAddress(tx.to) ?? tx.to;

  if (txSender !== intent.supporter_wallet) {
    return NextResponse.json(
      {
        error: "transaction_mismatch",
        stage: "verification",
        requestId,
        message: "Transaction sender does not match.",
      },
      { status: 422 },
    );
  }
  if (txRecipient !== intent.recipient_wallet) {
    return NextResponse.json(
      {
        error: "transaction_mismatch",
        stage: "verification",
        requestId,
        message: "Transaction recipient does not match.",
      },
      { status: 422 },
    );
  }
  if (tx.value !== Number(intent.amount_luna)) {
    return NextResponse.json(
      {
        error: "transaction_mismatch",
        stage: "verification",
        requestId,
        message: "Transaction amount does not match.",
      },
      { status: 422 },
    );
  }
  if (tx.data && tx.data !== intent.memo) {
    return NextResponse.json(
      {
        error: "transaction_mismatch",
        stage: "verification",
        requestId,
        message: "Transaction memo does not match.",
      },
      { status: 422 },
    );
  }
  if (tx.executionResult === false) {
    return NextResponse.json(
      {
        error: "transaction_mismatch",
        stage: "verification",
        requestId,
        message: "Transaction execution failed.",
      },
      { status: 422 },
    );
  }

  // 8. Atomic confirmation via database function
  // confirm_nim_contribution_atomic not in generated Database types — cast to `any`
  const { data: result, error: rpcErr } = await (admin.rpc as any)(
    "confirm_nim_contribution_atomic",
    {
      _intent_id: intentId,
      _transaction_hash: txHash,
      _block_number: tx.blockNumber ?? null,
      _transaction_ts: tx.timestamp
        ? new Date(tx.timestamp * 1000).toISOString()
        : null,
    },
  );

  if (rpcErr) {
    log("rpc_failed", {
      requestId,
      code: rpcErr.code,
      message: rpcErr.message,
    });
    return NextResponse.json(
      {
        error: "confirmation_failed",
        stage: "rpc",
        requestId,
        message: "Could not confirm the contribution.",
      },
      { status: 500 },
    );
  }

  const r = result as Record<string, unknown>;
  const kind = r.result_kind as string;

  if (kind === "created" || kind === "replay") {
    log("contribution_confirmed", { requestId, result_kind: kind });
    return NextResponse.json(
      {
        contribution: { id: r.contribution_id },
        resultKind: kind,
      },
      { status: kind === "created" ? 201 : 200 },
    );
  }

  if (kind === "intent_expired") {
    return NextResponse.json(
      {
        error: "intent_expired",
        stage: "intent",
        requestId,
        message: "Support intent has expired.",
      },
      { status: 410 },
    );
  }
  if (kind === "intent_already_used") {
    return NextResponse.json(
      {
        error: "intent_already_used",
        stage: "intent",
        requestId,
        message: "This intent was already confirmed with a different transaction.",
      },
      { status: 409 },
    );
  }
  if (kind === "transaction_already_used") {
    return NextResponse.json(
      {
        error: "transaction_already_used",
        stage: "verification",
        requestId,
        message: "This transaction was already credited to another contribution.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      error: "confirmation_failed",
      stage: "rpc",
      requestId,
      message: "Could not confirm the contribution.",
    },
    { status: 500 },
  );
}
