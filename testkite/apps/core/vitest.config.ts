import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PGlite keeps a separate WASM heap per instance — run serially to avoid blowing CI RAM.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
