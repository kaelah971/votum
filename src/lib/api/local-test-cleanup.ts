/**
 * Shared local-only test cleanup helper.
 *
 * Uses Docker psql to reliably delete test records — Supabase REST DELETE
 * is blocked by RLS (revoked in migration 20260731063021).
 *
 * Refuses hosted (*.supabase.co) targets.
 * Never prints credentials.
 *
 * Usage:
 *   import { cleanupTestWallet } from "./local-test-cleanup";
 *   await cleanupTestWallet(wallet);
 */
import { execFileSync } from "node:child_process";

function ensureLocal(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url || url.includes(".supabase.co")) {
    throw new Error(
      "cleanupTestWallet: refusing hosted Supabase target. " +
      "Set NEXT_PUBLIC_SUPABASE_URL to a local instance."
    );
  }
}

/**
 * Delete all records associated with a test wallet.
 * Removes dependent records in safe FK order.
 * Throws if cleanup fails (no silent catch).
 */
export function cleanupTestWallet(wallet: string): void {
  ensureLocal();

  const sql = `
    DELETE FROM public.nim_contributions
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.nim_support_intents
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_votes
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${wallet}');
    DELETE FROM public.poll_publication_requests
      WHERE creator_wallet = '${wallet}';
    DELETE FROM public.polls
      WHERE creator_wallet = '${wallet}';
    DELETE FROM public.participant_profiles
      WHERE wallet_address = '${wallet}';
    DELETE FROM public.wallet_sessions
      WHERE wallet_address = '${wallet}';
  `;

  execFileSync("docker", [
    "exec", "supabase_db_votum",
    "psql", "-U", "postgres", "-d", "postgres",
    "-c", sql,
  ], { stdio: "pipe" });
}
