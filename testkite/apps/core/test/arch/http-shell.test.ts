/**
 * Tầng shell (`src/http/**`, `composition-root.ts`) đứng NGOÀI DAG 12 module nên
 * eslint-boundaries không soi nó. Guard này thay thế: shell được phép ghép nhiều
 * module, nhưng CHỈ qua facade — chạm `modules/x/db/*` là mở lại đúng cái cửa mà
 * ownership.json đóng.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(fileURLToPath(new URL("../../src", import.meta.url)));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("tầng shell HTTP", () => {
  const shell = [...tsFiles(path.join(SRC, "http")), path.join(SRC, "composition-root.ts")];

  it("quét được file shell", () => {
    expect(shell.length).toBeGreaterThan(3);
  });

  it("chỉ import module qua facade index.js, không chạm db/* của module", () => {
    const bad: string[] = [];
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']*modules\/[^"']+)["']/g)) {
        const spec = m[1] ?? "";
        // Cho phép: .../modules/<name>/index.js và .../modules/<name>/routes.js
        if (/modules\/[a-z-]+\/(index|routes)\.js$/.test(spec)) continue;
        bad.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("shell KHÔNG chứa truy vấn SQL — nghiệp vụ nằm trong module", () => {
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(SRC, file)).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE .*SET|DELETE FROM)\b/i);
    }
  });
});
