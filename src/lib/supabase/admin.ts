import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

export type AdminConfigStatus =
  | { configured: true }
  | { configured: false; reason: string };

/**
 * Validate that all required admin-level environment variables are present.
 * The secret key is NOT exposed — this only returns a boolean status.
 */
export function getAdminConfigStatus(): AdminConfigStatus {
  if (!supabaseUrl) {
    return { configured: false, reason: "Missing NEXT_PUBLIC_SUPABASE_URL" };
  }
  if (!secretKey) {
    return { configured: false, reason: "Missing SUPABASE_SECRET_KEY" };
  }
  return { configured: true };
}

/**
 * Create a Supabase admin client using the secret (service_role) key.
 *
 * IMPORTANT: The secret key is NEVER exported from this module.
 * `server-only` enforces that this module cannot be imported from
 * client code — the build will fail if that is attempted.
 *
 * Returns `null` when the required environment variables are not set,
 * so callers can safely check before use.
 */
export function createAdminClient() {
  const config = getAdminConfigStatus();
  if (!config.configured) return null;

  return createClient<Database>(supabaseUrl!, secretKey!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { schema: "public" },
  });
}
