import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getVerifiedWalletSession } from "@/lib/api/session";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function log(stage: string, data: Record<string, unknown>) {
  console.error("[vote]", { stage, ...data });
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
        message: "A verified wallet session is required to vote.",
      },
      { status: 401 },
    );
  }
  const voterWallet = session.address;

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

  const optionId =
    typeof (body as Record<string, unknown>).optionId === "string"
      ? (body as Record<string, unknown>).optionId
      : "";
  if (!optionId) {
    return NextResponse.json(
      {
        error: "validation_failed",
        stage: "validation",
        requestId,
        message: "optionId is required.",
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

  // 5. Cast vote via atomic database function
  try {
    const { data: result, error: rpcErr } = await admin.rpc(
      "cast_poll_vote_atomic",
      {
        _poll_id: pollId,
        _option_id: optionId,
        _voter_wallet: voterWallet,
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
          error: "vote_failed",
          stage: "rpc",
          requestId,
          message: "Could not cast vote.",
        },
        { status: 500 },
      );
    }

    const r = result as Record<string, unknown>;
    const resultKind = r.result_kind as string;

    switch (resultKind) {
      case "created":
        log("vote_created", { requestId, status: 201 });
        return NextResponse.json(
          {
            vote: {
              id: r.vote_id,
              pollId,
              optionId,
              createdAt: r.created_at,
            },
            resultKind: "created",
          },
          { status: 201 },
        );

      case "replay":
        return NextResponse.json({
          vote: { id: r.vote_id, pollId, optionId },
          resultKind: "replay",
        });

      case "already_voted":
        return NextResponse.json(
          {
            error: "already_voted",
            stage: "vote",
            requestId,
            message:
              "You have already voted for a different option in this poll.",
            existingOptionId: r.option_id,
          },
          { status: 409 },
        );

      case "poll_not_found":
        return NextResponse.json(
          {
            error: "poll_not_found",
            stage: "poll",
            requestId,
            message: "Poll not found.",
          },
          { status: 404 },
        );

      case "poll_not_open":
        return NextResponse.json(
          {
            error: "poll_not_open",
            stage: "poll",
            requestId,
            message: "This poll is not currently accepting votes.",
          },
          { status: 423 },
        );

      case "invalid_option":
        return NextResponse.json(
          {
            error: "invalid_option",
            stage: "validation",
            requestId,
            message: "The selected option does not belong to this poll.",
          },
          { status: 422 },
        );

      default:
        return NextResponse.json(
          {
            error: "vote_failed",
            stage: "rpc",
            requestId,
            message: "Unexpected vote result.",
          },
          { status: 500 },
        );
    }
  } catch (err) {
    log("unexpected_error", { requestId, error: String(err) });
    return NextResponse.json(
      {
        error: "vote_failed",
        stage: "server",
        requestId,
        message: "Could not cast vote.",
      },
      { status: 500 },
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pollId: string }> },
) {
  const { pollId } = await params;
  const requestId = randomBytes(8).toString("hex");

  // No session → not voted (graceful, not an error)
  const session = await getVerifiedWalletSession();
  if (!session) {
    return NextResponse.json({ voted: false });
  }

  // Admin client unavailable → not voted (graceful degradation)
  const adminConfig = getAdminConfigStatus();
  if (!adminConfig.configured) {
    return NextResponse.json({ voted: false });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ voted: false });
  }

  try {
    const { data, error } = await admin
      .from("poll_votes")
      .select("id, option_id, created_at")
      .eq("poll_id", pollId)
      .eq("voter_wallet", session.address)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ voted: false });
    }

    return NextResponse.json({
      voted: true,
      vote: { id: data.id, optionId: data.option_id, createdAt: data.created_at },
    });
  } catch {
    log("get_vote_failed", { requestId });
    return NextResponse.json({ voted: false });
  }
}
