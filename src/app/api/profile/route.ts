import { NextResponse } from "next/server";
import { getPublicProfileByWallet, getPublicProfileByHandle } from "@/lib/profiles/queries";

export const runtime = "nodejs";

/**
 * GET /api/profile?wallet=<address>
 * GET /api/profile?handle=<handle>
 *
 * Public profile resolution (canonical wallet or friendly handle). Exactly
 * one of wallet/handle must be provided. Unknown or malformed lookups return
 * 404 — never raw errors. The response is the deep allowlisted public shape;
 * it can never contain session/auth internals or vote choices.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");
  const handle = searchParams.get("handle");

  const walletProvided = wallet !== null && wallet.length > 0;
  const handleProvided = handle !== null && handle.length > 0;

  if (walletProvided === handleProvided) {
    return NextResponse.json(
      { error: "invalid_query", message: "Provide exactly one of wallet or handle." },
      { status: 400 },
    );
  }

  const result = walletProvided
    ? await getPublicProfileByWallet(wallet as string)
    : await getPublicProfileByHandle(handle as string);

  if (!result) {
    return NextResponse.json(
      { error: "profile_not_found", message: "No public Votum profile found." },
      { status: 404 },
    );
  }

  return NextResponse.json(result);
}
