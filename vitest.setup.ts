import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { loadLocalEnvForTests } from "@/lib/rewards/test-env";

// Load .env.local (dotenv last-wins) before any test module reads env, so
// server-gated modules like the admin client see the LOCAL Supabase config.
// NODE_ENV=test makes @next/env skip .env.local, hence the explicit loader.
loadLocalEnvForTests();

afterEach(() => {
  cleanup();
});
