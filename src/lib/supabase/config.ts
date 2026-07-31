import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function isValidSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith(".supabase.co") ||
      parsed.hostname === "localhost"
    );
  } catch {
    return false;
  }
}

export type ConfigStatus =
  | { configured: true }
  | { configured: false; reason: string };

export function getConfigStatus(): ConfigStatus {
  if (!supabaseUrl) {
    return { configured: false, reason: "Missing NEXT_PUBLIC_SUPABASE_URL" };
  }
  if (!isValidSupabaseUrl(supabaseUrl)) {
    return { configured: false, reason: "Invalid Supabase project URL" };
  }
  if (!supabaseKey) {
    return {
      configured: false,
      reason: "Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  return { configured: true };
}

export function createServerClient() {
  const config = getConfigStatus();
  if (!config.configured) {
    return null;
  }

  return createClient<Database>(supabaseUrl!, supabaseKey!, {
    db: { schema: "public" },
  });
}
