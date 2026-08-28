/**
 * Architecture guard — the Global Constraint from the M1 kernel-db plan:
 * "A table belongs to exactly 1 module per ownership.json. Another module wanting
 *  that data: calls the facade (forward along the DAG) or listens for a domain event."
 *
 * Specifically: a cross-module import MUST point at the facade `<module>/index.js`,
 * NEVER reach directly into an internal file (`db/schema.js`, `db/repo.js`, ...).
 *
 * Why guard this with a test: `aut_cases` (Task 5) is the TEMPLATE for the ~50 sibling
 * tables still to come. If the reach-into-internal-file anti-pattern slips through even
 * once, it will get copied across all of authoring/planning/orchestration/... before eslint-boundaries is even in place.
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

/**
 * Only relative specifiers (`./` or `../`) matter — external packages aren't a module
 * boundary concern. Scans all THREE ways a file can reach another module's path: a static
 * `import ... from "..."` (or `export ... from "..."`), a dynamic `import("...")`
 * expression, and a CommonJS `require("...")` call — a boundary crossing hidden behind
 * `await import(...)` is just as real as a static one (NIT-TEST-F5).
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /from\s*["'](\.[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
];

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(pattern)) if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

/** The name of the module that owns a file, i.e. the first segment under `src/modules/`. */
function moduleOf(absPath: string): string | undefined {
  const rel = path.relative(MODULES_DIR, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0];
}

describe("module boundaries", () => {
  const files = listTsFiles(MODULES_DIR);

  it("scans the modules' source", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every cross-module import goes through the index.js facade, never touching an internal file", () => {
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

  it("relativeSpecifiers() also catches a dynamic import() and a require(), not just static `from` (TEST-F5 regression)", () => {
    expect(relativeSpecifiers(`import { x } from "../other-module/index.js";`)).toEqual([
      "../other-module/index.js",
    ]);
    expect(relativeSpecifiers(`const repo = await import("../other-module/db/repo.js");`)).toEqual([
      "../other-module/db/repo.js",
    ]);
    expect(relativeSpecifiers(`const repo = require("../other-module/db/repo.js");`)).toEqual([
      "../other-module/db/repo.js",
    ]);
  });
});
