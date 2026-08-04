/**
 * Local-only environment loader for standalone tsx scripts.
 *
 * Loads .env.local so test/seed scripts can access Supabase config
 * without hardcoded keys. Uses @next/env which ships with Next.js.
 *
 * Usage (first line of script):
 *   import "./load-local-env";
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";

const dir = resolve(process.cwd());
loadEnvConfig(dir);
