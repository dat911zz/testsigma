/**
 * `module-dag.json` and `ownership.json` describe the SAME set of 12 modules. Adding a
 * module to one file and forgetting the other = a module with no lint rule guarding it,
 * silently, forever. This test turns that silence red.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Both files carry a `$comment` key as documentation — filter it out before any comparison. */
const stripComments = (o: Record<string, unknown>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("$"))) as Record<string, string[]>;

const rawDag = require("../module-dag.json") as Record<string, unknown>;
const dag = Object.fromEntries(
  Object.entries(rawDag).filter(([k]) => !k.startsWith("$")),
) as Record<string, string[]>;
const ownership = stripComments(require("../ownership.json") as Record<string, unknown>);

describe("module-dag.json", () => {
  it("has the same set of keys as ownership.json", () => {
    expect(Object.keys(dag).sort()).toEqual(Object.keys(ownership).sort());
  });

  /**
   * "12 modules" is a NAME used in docs/SYSTEM_DESIGN.md §4, not a count: the list
   * right after it names 13 (kernel, identity, governance, verbs,
   * elements, testdata, authoring, planning, orchestration, results + the edge trio
   * integrations, ai, mcp). `ownership.json`, already committed earlier, also has
   * exactly 13 keys. Pinning the REAL number here acts as a tripwire: adding or
   * removing a module turns this test red.
   */
  it("has exactly 13 modules (the '12 modules' label in §4 is a name, not a count)", () => {
    expect(Object.keys(dag)).toHaveLength(13);
  });

  it("every allowed target is a real module", () => {
    const names = new Set(Object.keys(dag));
    for (const [from, allowed] of Object.entries(dag)) {
      for (const to of allowed) expect(names.has(to), `${from} → ${to} does not exist`).toBe(true);
    }
  });

  it("no module lists itself in its own allow list", () => {
    for (const [from, allowed] of Object.entries(dag)) expect(allowed).not.toContain(from);
  });

  it("is a REAL DAG — the allow relation has no cycles", () => {
    // A cycle exists when A allows B and B allows A (or a longer chain back to A).
    const reach = new Map<string, Set<string>>();
    const walk = (n: string, seen: Set<string>): Set<string> => {
      const cached = reach.get(n);
      if (cached !== undefined) return cached;
      const out = new Set<string>();
      for (const next of dag[n] ?? []) {
        expect(seen.has(next), `cycle through ${n} → ${next}`).toBe(false);
        out.add(next);
        for (const deep of walk(next, new Set([...seen, next]))) out.add(deep);
      }
      reach.set(n, out);
      return out;
    };
    for (const n of Object.keys(dag)) walk(n, new Set([n]));
  });

  it("kernel is the root — it may not import any module", () => {
    expect(dag["kernel"]).toEqual([]);
  });

  it("an edge module is never the target of a core module", () => {
    const edge = ["integrations", "ai", "mcp-gateway"];
    for (const [from, allowed] of Object.entries(dag)) {
      if (edge.includes(from)) continue;
      for (const e of edge) expect(allowed, `${from} must not import ${e}`).not.toContain(e);
    }
  });
});
