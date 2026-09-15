/**
 * Test-only database target resolution.
 *
 * DB-backed tests default to the historical local Supabase stack
 * (`supabase_db_votum` + `.env.local` URL). Setting the VOTUM_CLEANROOM_*
 * overrides redirects both the Supabase client and the docker-psql cleanup
 * plumbing at a disposable clean-room instance instead.
 *
 * Production behavior is untouched: this module is imported by tests and
 * local tsx scripts only. Values are never printed.
 */

export function testSupabaseUrl(): string {
  return (
    process.env.VOTUM_CLEANROOM_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    ""
  );
}

export function testSupabaseKey(): string {
  return (
    process.env.VOTUM_CLEANROOM_SUPABASE_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    ""
  );
}

export function testDbContainer(): string {
  return process.env.VOTUM_CLEANROOM_DB_CONTAINER ?? "supabase_db_votum";
}
