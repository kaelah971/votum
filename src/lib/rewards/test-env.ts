/**
 * Test-only env loader that mirrors dotenv semantics for .env.local.
 *
 * Node's `@next/env` `loadEnvConfig` skips `.env.local` when NODE_ENV=test
 * (vitest's default), so vitest integration tests cannot reach the local DB
 * through the shared `load-local-env`. This loader re-reads `.env.local`
 * directly with dotenv last-wins behaviour (later duplicate keys override
 * earlier ones — the local Supabase URL is the later of two definitions).
 *
 * Values are set into process.env only if not already present, and
 * NEXT_PUBLIC_SUPABASE_URL is force-set to the parsed last-wins value so a
 * hosted URL listed first can never win.
 *
 * Never prints values.
 */
import { readFileSync } from "node:fs";

/** Hostnames that are acceptable for local integration tests. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True when a URL points at a local dev Supabase instance. */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  const host = hostnameOf(url);
  return (
    LOCAL_HOSTNAMES.has(host) ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Fail-closed guard for local integration tests.
 *
 * Throws if the effective Supabase URL is NOT a local dev instance. This
 * prevents any local V2B checkpoint test from accidentally issuing DB reads
 * or writes against a hosted Supabase project. Hostname-only check (never
 * prints credentials or values).
 */
export function assertLocalSupabaseForTests(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!isLocalSupabaseUrl(url)) {
    throw new Error(
      "integration test refused: NEXT_PUBLIC_SUPABASE_URL must point at a local " +
        "Supabase instance (localhost / 127.0.0.1 / LAN private range); got " +
        (url ? hostnameOf(url) || "unparseable" : "unset"),
    );
  }
  return url as string;
}

export function loadLocalEnvForTests(): void {
  const raw = readFileSync(".env.local", "utf8");
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      parsed[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  if (parsed.NEXT_PUBLIC_SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = parsed.NEXT_PUBLIC_SUPABASE_URL;
  }
  // Fail closed: local integration tests must never reach a hosted DB.
  assertLocalSupabaseForTests();
}
