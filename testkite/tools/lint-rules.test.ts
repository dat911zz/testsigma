/**
 * Luật lint cũng là code — nên nó cũng có test.
 *
 * Fixture ở `tools/lint-fixtures/` gương lại đúng cấu trúc thư mục thật để
 * eslint-plugin-boundaries phân loại chúng y như file production. `pnpm lint`
 * chỉ nhắm `apps packages` nên không bao giờ chạm vào chúng; test này gọi
 * thẳng ESLint Node API.
 *
 * Một fixture BẮT BUỘC mang tên `*.test.ts` — `pure-ok.test.ts` — vì thứ đang được
 * kiểm chứng chính là `ignores: ["**\/packages/run-compiler/src/**\/*.test.ts"]` của
 * block PURE. Nó không chứa test nào, nên script `test:tools` phải loại
 * `tools/lint-fixtures/**` khỏi tầm thu của vitest; thiếu cờ đó vitest gom nó vào và
 * chết với "No test suite found in file".
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
  if (first === undefined) throw new Error(`ESLint không trả kết quả nào cho ${relPath}`);
  return first.messages.map((m) => m.ruleId ?? "<no-rule>");
}

describe("DAG 12 module (boundaries/dependencies)", () => {
  it("BẮT import ngược DAG: kernel → identity", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/dag-backward.ts")).toContain("boundaries/dependencies");
  });

  it("CHO QUA import xuôi DAG: results → planning", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-forward.ts")).toEqual([]);
  });

  it("BẮT import module rìa từ lõi: results → ai", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-edge-inward.ts")).toContain(
      "boundaries/dependencies",
    );
  });
});

describe("run-compiler PURE (no-restricted-*)", () => {
  it("CHO QUA node:crypto — phase 7 băm SHA-256 bằng createHash", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.ts")).toEqual([]);
  });

  it("BẮT node:fs", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-imports");
  });

  it("BẮT Date.now và Math.random", async () => {
    const ids = await lintFixture("packages/run-compiler/src/pure-violations.ts");
    expect(ids.filter((r) => r === "no-restricted-properties").length).toBeGreaterThanOrEqual(2);
  });

  it("BẮT process", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-globals");
  });

  it("CHO QUA node:fs trong *.test.ts — golden suite đọc fixture bằng readFileSync", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.test.ts")).toEqual([]);
  });
});

describe("queue chỉ trong kernel", () => {
  it("BẮT bullmq trong orchestration", async () => {
    expect(await lintFixture("apps/core/src/modules/orchestration/queue-outside-kernel.ts")).toContain(
      "no-restricted-imports",
    );
  });

  it("CHO QUA bullmq trong kernel", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/queue-allowed.ts")).toEqual([]);
  });
});
