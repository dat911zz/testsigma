/**
 * Guard kiến trúc — Global Constraint của plan M1 kernel-db:
 * "Bảng thuộc đúng 1 module theo ownership.json. Module khác muốn dữ liệu:
 *  gọi facade (xuôi DAG) hoặc nghe domain event."
 *
 * Cụ thể: import chéo module PHẢI trỏ vào facade `<module>/index.js`, KHÔNG BAO GIỜ
 * với tay thẳng vào file nội bộ (`db/schema.js`, `db/repo.js`, ...).
 *
 * Vì sao guard bằng test: `aut_cases` (Task 5) là MẪU cho ~50 bảng con lai còn lại.
 * Nếu anti-pattern reach-into-internal-file lọt một lần, nó sẽ được sao chép sang
 * toàn bộ authoring/planning/orchestration/... trước khi eslint-boundaries kịp có mặt.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULES_DIR = path.resolve(fileURLToPath(new URL("../../src/modules", import.meta.url)));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Chỉ quan tâm specifier tương đối (`./` hoặc `../`) — package ngoài không phải ranh giới module. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s*["'](\.[^"']+)["']/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
}

/** Tên module sở hữu file, tức segment đầu tiên dưới `src/modules/`. */
function moduleOf(absPath: string): string | undefined {
  const rel = path.relative(MODULES_DIR, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0];
}

describe("ranh giới module", () => {
  const files = listTsFiles(MODULES_DIR);

  it("quét được source của các module", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("mọi import chéo module đều đi qua facade index.js, không chạm file nội bộ", () => {
    const violations: string[] = [];

    for (const file of files) {
      const owner = moduleOf(file);
      if (owner === undefined) continue;

      for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
        const resolved = path.resolve(path.dirname(file), spec);
        const target = moduleOf(resolved);
        if (target === undefined || target === owner) continue;

        const facade = path.join(MODULES_DIR, target, "index.js");
        if (resolved !== facade) {
          violations.push(`${path.relative(MODULES_DIR, file)} -> ${spec}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
