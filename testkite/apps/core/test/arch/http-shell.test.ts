/**
 * The shell tier (`src/http/**`, `composition-root.ts`) sits OUTSIDE the 12-module DAG,
 * so eslint-boundaries doesn't inspect it. This guard fills that gap: the shell is allowed
 * to wire multiple modules together, but ONLY through their facades — touching
 * `modules/x/db/*` reopens exactly the door ownership.json closed.
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

describe("HTTP shell tier", () => {
  const shell = [...tsFiles(path.join(SRC, "http")), path.join(SRC, "composition-root.ts")];

  it("scans the shell files", () => {
    expect(shell.length).toBeGreaterThan(3);
  });

  it("only imports a module through its index.js facade, never touching the module's db/*", () => {
    const bad: string[] = [];
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']*modules\/[^"']+)["']/g)) {
        const spec = m[1] ?? "";
        // Allowed: .../modules/<name>/index.js and .../modules/<name>/routes.js
        if (/modules\/[a-z-]+\/(index|routes)\.js$/.test(spec)) continue;
        bad.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the shell contains NO SQL queries — business logic lives in the modules", () => {
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(SRC, file)).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE .*SET|DELETE FROM)\b/i);
    }
  });
});
