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
}
