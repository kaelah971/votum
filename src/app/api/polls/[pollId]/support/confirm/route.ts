import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { getTransactionByHash, validateTransactionHash } from "@/lib/nimiq/rpc";

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

  // 1. Session
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json({ error: "session_missing", stage: "session", requestId, message: "A verified wallet session is required." }, { status: 401 });
  }
  const supporterWallet = normalizeAddress(session.address) ?? session.address;

  // 2. Parse body
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid_json", stage: "body", requestId, message: "Invalid JSON." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const intentId = typeof b.intentId === "string" ? b.intentId : "";
  const rawTxHash = typeof b.transactionHash === "string" ? b.transactionHash : "";
  if (!intentId || !rawTxHash) {
    return NextResponse.json({ error: "validation_failed", stage: "validation", requestId, message: "intentId and transactionHash are required." }, { status: 400 });
  }

  // 3. Validate hash format
  const txHash = validateTransactionHash(rawTxHash);
  if (!txHash) {
    return NextResponse.json({ error: "invalid_hash", stage: "validation", requestId, message: "Invalid transaction hash format." }, { status: 400 });
  }

  // 4. Admin client
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json({ error: "service_unavailable", stage: "admin", requestId, message: "Server not configured." }, { status: 503 });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "service_unavailable", stage: "admin", requestId, message: "Admin client unavailable." }, { status: 503 });
  }

  // 5. Load intent (nim_support_intents not in generated Database types — cast to any)
  const intentQuery = admin.from("nim_support_intents" as any) as any;
  const { data: rawIntent, error: intentErr } = await intentQuery
    .select("*")
    .eq("id", intentId)
    .single();
  const intent = rawIntent as Record<string, unknown> | null;

  if (intentErr || !intent) {
    return NextResponse.json({ error: "intent_not_found", stage: "intent", requestId, message: "Support intent not found." }, { status: 404 });
  }
  if (intent.poll_id !== pollId) {
    return NextResponse.json({ error: "intent_not_found", stage: "intent", requestId, message: "Intent does not belong to this poll." }, { status: 404 });
  }
  if (intent.supporter_wallet !== supporterWallet) {
    return NextResponse.json({ error: "intent_not_found", stage: "intent", requestId, message: "Intent does not belong to this wallet." }, { status: 404 });
  }

  // 6. Bind transaction hash to intent (or replay binding)
  const { data: bindResult, error: bindErr } = await admin.rpc(
    "bind_nim_support_transaction_atomic" as any,
    {
      _intent_id: intentId,
      _transaction_hash: txHash,
      _supporter_wallet: supporterWallet,
    } as any,
  );

  if (bindErr) {
    log("bind_failed", { requestId, code: bindErr.code, message: bindErr.message });
    return NextResponse.json({ error: "confirmation_failed", stage: "bind", requestId, message: "Could not bind transaction." }, { status: 500 });
  }

  const br = bindResult as Record<string, unknown>;
  const bindKind = br.result_kind as string;

  if (bindKind === "intent_expired") {
    return NextResponse.json({ error: "intent_expired", stage: "intent", requestId, message: "Support intent has expired." }, { status: 410 });
  }
  if (bindKind === "intent_already_bound") {
    return NextResponse.json({ error: "intent_already_bound", stage: "intent", requestId, message: "This intent was already bound to a different transaction." }, { status: 409 });
  }
  if (bindKind === "intent_already_confirmed") {
    return NextResponse.json({ error: "intent_already_confirmed", stage: "intent", requestId, message: "This intent has already been confirmed." }, { status: 409 });
  }
  if (bindKind === "transaction_already_reserved") {
    return NextResponse.json({ error: "transaction_already_reserved", stage: "bind", requestId, message: "This transaction hash is already reserved by another intent." }, { status: 409 });
  }
  if (bindKind !== "bound" && bindKind !== "bound_replay") {
    return NextResponse.json({ error: "confirmation_failed", stage: "bind", requestId, message: "Could not bind transaction." }, { status: 500 });
  }

  // 7. Fetch transaction from RPC
  const txResult = await getTransactionByHash(txHash);
  if ("error" in txResult) {
    if (txResult.error === "not_found") {
      return NextResponse.json({
        status: "pending",
        stage: "inclusion",
        requestId,
        retryable: true,
        retryAfterMs: 5000,
        message: "Your transaction was sent and is waiting for confirmation.",
      }, { status: 202 });
    }
    log("rpc_error", { requestId, error: txResult.error, message: txResult.message });
    return NextResponse.json({ error: "rpc_unavailable", stage: "rpc", requestId, message: "Could not verify the transaction." }, { status: 502 });
  }
  const tx = txResult.data;

  // 8. Verify transaction fields match intent
  const txSender = normalizeAddress(tx.sender) ?? tx.sender;
  const txRecipient = normalizeAddress(tx.recipient) ?? tx.recipient;

  if (txSender !== intent.supporter_wallet) {
    return NextResponse.json({ error: "transaction_mismatch", stage: "verification", requestId, message: "Transaction sender does not match." }, { status: 422 });
  }
  if (txRecipient !== intent.recipient_wallet) {
    return NextResponse.json({ error: "transaction_mismatch", stage: "verification", requestId, message: "Transaction recipient does not match." }, { status: 422 });
  }
  if (tx.valueLuna !== BigInt(Number(intent.amount_luna))) {
    return NextResponse.json({ error: "transaction_mismatch", stage: "verification", requestId, message: "Transaction amount does not match." }, { status: 422 });
  }
  if (tx.recipientData !== intent.memo) {
    return NextResponse.json({ error: "transaction_mismatch", stage: "verification", requestId, message: "Transaction memo does not match." }, { status: 422 });
  }

  // 9. Atomic confirmation
  const { data: result, error: rpcErr } = await admin.rpc(
    "confirm_nim_contribution_atomic" as any,
    {
      _intent_id: intentId,
      _transaction_hash: txHash,
      _block_number: tx.blockHeight ?? null,
      _transaction_ts: tx.timestampMs
        ? new Date(tx.timestampMs).toISOString()
        : null,
    } as any,
  );

  if (rpcErr) {
    log("confirm_rpc_failed", { requestId, code: rpcErr.code, message: rpcErr.message });
    return NextResponse.json({ error: "confirmation_failed", stage: "rpc", requestId, message: "Could not confirm the contribution." }, { status: 500 });
  }

  const r = result as Record<string, unknown>;
  const kind = r.result_kind as string;

  if (kind === "created" || kind === "replay") {
    log("contribution_confirmed", { requestId, result_kind: kind });
    return NextResponse.json({
      contribution: { id: r.contribution_id },
      resultKind: kind,
    }, { status: kind === "created" ? 201 : 200 });
  }

  return NextResponse.json({ error: "confirmation_failed", stage: "rpc", requestId, message: "Could not confirm the contribution." }, { status: 500 });
}
