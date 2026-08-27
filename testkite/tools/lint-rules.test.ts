/**
 * Luật lint cũng là code — nên nó cũng có test.
 *
 * Fixture ở `tools/lint-fixtures/` gương lại đúng cấu trúc thư mục thật để
 * eslint-plugin-boundaries phân loại chúng y như file production. `pnpm lint`
 * chỉ nhắm `apps packages` nên không bao giờ chạm vào chúng; test này gọi
 * thẳng ESLint Node API.
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
