import { defineConfig } from "vitest/config";

/**
 * Browser-backed integration tests launch chromium-headless-shell; measured cold start in the
 * spike was ~1.1s, and a chain of 8 steps ~0.75s. 30s per test leaves room on a loaded CI box
 * without letting a genuinely hung test hold the suite for minutes.
 *
 * `test/host/**` and `test/soak/**` are OUT of the default run and each is re-admitted by its
 * own env flag — the same flag its package.json script sets:
 *   - `test:host` (TESTKITE_HOST_CGROUP=1): cgroup v2 `memory.max`/`memory.events`, a negative
 *     `oom_score_adj`, and a chromium launched with its OS sandbox actually ON — mechanisms this
 *     sandbox provably cannot exercise (cgroup v1 hybrid, no CAP_SYS_RESOURCE, and root, which
 *     chromium's zygote refuses to sandbox), so they are proven on a real host and nowhere else.
 *   - `test:soak` (TESTKITE_SOAK=1): the 200-chain soak, minutes long by design.
 * The flag drives `exclude` rather than the script's file filter because a vitest CLI path
 * argument only NARROWS the include set — it cannot re-admit a file that `exclude` dropped, so
 * a static exclude would make `test:host` match zero files and exit non-zero forever.
 */
const runHostTests = process.env["TESTKITE_HOST_CGROUP"] === "1";
const runSoakTests = process.env["TESTKITE_SOAK"] === "1";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: [
      ...(runSoakTests ? [] : ["test/soak/**"]),
      ...(runHostTests ? [] : ["test/host/**"]),
      "node_modules/**",
    ],
  },
});
