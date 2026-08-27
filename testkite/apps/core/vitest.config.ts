import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PGlite giữ WASM heap riêng cho mỗi instance — chạy tuần tự để không thổi RAM CI.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
