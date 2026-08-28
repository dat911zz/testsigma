/**
 * Lint rules are code too — so they get tests too.
 *
 * The fixtures under `tools/lint-fixtures/` mirror the real directory structure exactly
 * so eslint-plugin-boundaries classifies them the same way it would production files.
 * `pnpm lint` only targets `apps packages`, so it never touches them; this test calls
 * the ESLint Node API directly.
 *
 * One fixture MUST be named `*.test.ts` — `pure-ok.test.ts` — because what's being
 * verified is exactly the PURE block's `ignores: ["**\/packages/run-compiler/src/**\/*.test.ts"]`.
 * It contains no tests, so the `test:tools` script has to exclude
 * `tools/lint-fixtures/**` from vitest's collection scope; without that flag vitest
 * picks it up and dies with "No test suite found in file".
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: workspaceRoot });

async function lintFixture(relPath: string): Promise<string[]> {
  const results = await eslint.lintFiles([join(workspaceRoot, "tools", "lint-fixtures", relPath)]);
  const first = results[0];
  if (first === undefined) throw new Error(`ESLint returned no result for ${relPath}`);
  return first.messages.map((m) => m.ruleId ?? "<no-rule>");
}

describe("12-module DAG (boundaries/dependencies)", () => {
  it("CATCHES an import that goes backward through the DAG: kernel → identity", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/dag-backward.ts")).toContain("boundaries/dependencies");
  });

  it("ALLOWS a forward import along the DAG: results → planning", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-forward.ts")).toEqual([]);
  });

  it("CATCHES a core module importing an edge module: results → ai", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-edge-inward.ts")).toContain(
      "boundaries/dependencies",
    );
  });
});

describe("run-compiler PURE (no-restricted-*)", () => {
  it("ALLOWS node:crypto — phase 7 hashes SHA-256 via createHash", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.ts")).toEqual([]);
  });

  it("CATCHES node:fs", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-imports");
  });

  it("CATCHES Date.now and Math.random", async () => {
    const ids = await lintFixture("packages/run-compiler/src/pure-violations.ts");
    expect(ids.filter((r) => r === "no-restricted-properties").length).toBeGreaterThanOrEqual(2);
  });

  it("CATCHES process", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-globals");
  });

  it("ALLOWS node:fs inside *.test.ts — the golden suite reads fixtures via readFileSync", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.test.ts")).toEqual([]);
  });

  it("CATCHES BARE builtins: child_process/os/path/url/timers", async () => {
    const ids = await lintFixture("packages/run-compiler/src/pure-bare.ts");
    expect(ids.filter((r) => r === "no-restricted-imports")).toHaveLength(5);
  });

  it("CATCHES `await import()` — dynamically loading node:fs and bullmq", async () => {
    const ids = await lintFixture("packages/run-compiler/src/pure-dynamic.ts");
    expect(ids.filter((r) => r === "no-restricted-syntax")).toHaveLength(2);
  });

  it("ALLOWS `await import(\"node:crypto\")` — the exact list is forbidden, not import() in general", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok-dynamic.ts")).toEqual([]);
  });
});

describe("queue only inside kernel", () => {
  it("CATCHES bullmq inside orchestration", async () => {
    expect(await lintFixture("apps/core/src/modules/orchestration/queue-outside-kernel.ts")).toContain(
      "no-restricted-imports",
    );
  });

  it("ALLOWS bullmq inside kernel", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/queue-allowed.ts")).toEqual([]);
  });

  it("CATCHES `await import(\"bullmq\")` inside orchestration", async () => {
    expect(await lintFixture("apps/core/src/modules/orchestration/queue-dynamic.ts")).toContain(
      "no-restricted-syntax",
    );
  });

  it("ALLOWS `await import(\"bullmq\")` inside kernel", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/queue-dynamic-allowed.ts")).toEqual([]);
  });
});
