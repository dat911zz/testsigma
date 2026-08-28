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

/**
 * All THREE ways a file can name a module path: a static `from "..."`, a dynamic
 * `import("...")` expression, and a CommonJS `require("...")` call — `await
 * import("../modules/x/db/repo.js")` reaches into the module's internals exactly as much
 * as a static import would, and the old regex (only `from`) let it through (TEST-F5).
 */
const MODULE_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /from\s+["'](\.\.?\/[^"']*modules\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.\.?\/[^"']*modules\/[^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["'](\.\.?\/[^"']*modules\/[^"']+)["']\s*\)/g,
];

function shellModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(pattern)) if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

/** Allowed: .../modules/<name>/index.js and .../modules/<name>/routes.js */
const ALLOWED_MODULE_SPEC = /modules\/[a-z-]+\/(index|routes)\.js$/;

describe("HTTP shell tier", () => {
  const shell = [...tsFiles(path.join(SRC, "http")), path.join(SRC, "composition-root.ts")];

  it("scans the shell files", () => {
    expect(shell.length).toBeGreaterThan(3);
  });

  it("only imports a module through its index.js facade, never touching the module's db/*", () => {
    const bad: string[] = [];
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      for (const spec of shellModuleSpecifiers(src)) {
        if (ALLOWED_MODULE_SPEC.test(spec)) continue;
        bad.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("shellModuleSpecifiers() also catches a dynamic import() and a require(), not just static `from` (TEST-F5 regression)", () => {
    expect(shellModuleSpecifiers(`import { x } from "../modules/authoring/index.js";`)).toEqual([
      "../modules/authoring/index.js",
    ]);
    expect(
      shellModuleSpecifiers(`const repo = await import("../modules/authoring/db/repo.js");`),
    ).toEqual(["../modules/authoring/db/repo.js"]);
    expect(
      shellModuleSpecifiers(`const repo = require("../modules/authoring/db/repo.js");`),
    ).toEqual(["../modules/authoring/db/repo.js"]);
  });

  it("the shell contains NO SQL queries — business logic lives in the modules", () => {
    for (const file of shell) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(SRC, file)).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE .*SET|DELETE FROM)\b/i);
    }
  });
});
