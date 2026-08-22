import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // DB-backed + WASM crypto integration tests exceed the 5s default when the
    // full suite runs in parallel (Nimiq WASM init, local Supabase round-trips,
    // docker psql mutation/restore). 30s is a generous safety upper bound.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next.js resolves `server-only` to an empty module at build time; the
      // alias lets vitest import server-gated modules directly in tests.
      "server-only": path.resolve(__dirname, "vitest-server-only-stub.ts"),
    },
  },
});
