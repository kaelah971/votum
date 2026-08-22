import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
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
