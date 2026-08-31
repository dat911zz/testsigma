/**
 * Every `satisfies FieldMap<…>` table in the workspace has to be watched by SOMEBODY. A tier-2
 * test only sees its own app — apps/core and apps/runner are peers with no dependency between
 * them — so nothing inside either app can notice a THIRD table appearing in a third place, which
 * is exactly how the fence came out empty at the two adapters that needed it most.
 *
 * This test reads FILES instead of importing modules, which is why it may look at both apps at
 * once. `tools/` runs from the workspace root (`pnpm test:tools`).
 *
 * HONEST LIMIT: a text scan, not a type analysis. A table built through a helper, or a `FieldMap`
 * imported under another name, slips past. It watches exactly one spelling — the one every table
 * in this repo uses — and claims nothing more.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The workspace root: this file lives in `tools/`, one level down. */
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_ROOTS = ["apps", "packages"] as const;
const MARKER = "satisfies FieldMap<";

interface Entry {
  readonly occurrences: number;
  readonly table: string;
  readonly pinnedBy: string;
}

/**
 * Repo-relative file -> how many tables it holds, the exported const that holds them, and the
 * tier-2 test that pins its `null` entries. Adding a table anywhere means editing this list.
 */
const EXPECTED: Readonly<Record<string, Entry>> = {
  "apps/core/src/modules/orchestration/run-service.ts": {
    // Two flat tables plus one per union member of AuthoredStepDto (6 kinds).
    occurrences: 8,
    table: "ADAPTER_FIELD_MAPS",
    pinnedBy: "apps/core/test/arch/adapter-guard.test.ts",
  },
  "apps/core/src/http/internal/routes.ts": {
    occurrences: 1,
    table: "STEP_RESULT_FIELDS",
    pinnedBy: "apps/core/test/arch/adapter-guard.test.ts",
  },
  "apps/runner/src/worker.ts": {
    occurrences: 1,
    table: "COMPLETED_STEP_FIELDS",
    pinnedBy: "apps/runner/test/arch/field-map-drops.test.ts",
  },
};

/**
 * `<workspace>/src` only — never a whole package: apps carry their own node_modules, and
 * `tools/lint-fixtures/` deliberately holds broken copies of app trees. `*.test.ts` is skipped
 * because @testkite/contract keeps its tests inside `src/`, and `field-map.test.ts` uses the
 * marker on purpose.
 */
function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      if (!full.endsWith(".ts") || full.endsWith(".test.ts")) continue;
      const count = readFileSync(full, "utf8").split(MARKER).length - 1;
      if (count > 0) found[path.relative(ROOT, full)] = count;
    }
  };
  for (const root of SCAN_ROOTS) {
    for (const pkg of readdirSync(path.join(ROOT, root), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = path.join(ROOT, root, pkg.name, "src");
      if (existsSync(src)) visit(src);
    }
  }
  return found;
}

describe("FieldMap inventory", () => {
  it("holds exactly the tables this list names — a new one anywhere turns this red", () => {
    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([file, entry]) => [file, entry.occurrences]),
    );
    expect(scan()).toEqual(expected);
  });

  it("exports every table, so a tier-2 test can walk it", () => {
    for (const [file, entry] of Object.entries(EXPECTED)) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text, `${file} must export ${entry.table}`).toContain(`export const ${entry.table}`);
    }
  });

  it("names a tier-2 test for every table, and that test mentions it", () => {
    for (const [file, entry] of Object.entries(EXPECTED)) {
      const pin = readFileSync(path.join(ROOT, entry.pinnedBy), "utf8");
      expect(pin, `${entry.pinnedBy} must pin ${entry.table} (from ${file})`).toContain(entry.table);
    }
  });
});
