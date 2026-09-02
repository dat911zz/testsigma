/**
 * `docs/PROJECT_MAP.md` is the only document that claims to list EVERY module of the
 * monolith. A list like that rots the moment someone adds a directory under
 * `apps/core/src/modules/` or a key to `module-dag.json` — and prose rots silently,
 * which is exactly how README.md's structure block ended up advertising a BullMQ worker,
 * a 9-phase compiler and 35 active verbs, none of which were true.
 *
 * So the map gets a gate. This suite reads the DISK and `module-dag.json`, never the
 * map's own prose, and turns four kinds of drift red:
 *   (a) a module directory that exists on disk but has no block in the map,
 *   (b) a `module-dag.json` key that has no block in the map,
 *   (c) a block naming a module that exists in neither place,
 *   (d) a hand-edited mermaid graph that no longer matches `module-dag.json`.
 * Plus (e): README.md must keep pointing at the map, so the map stays discoverable
 * from the entry document rather than becoming a file nobody opens.
 *
 * The mermaid block is GENERATED here, by `mermaidFromDag`, and the map merely holds
 * a copy of that output. Drawing the graph by hand would make the picture a fifth
 * independent source of truth about the DAG — the map's whole point is that there is
 * exactly one (`module-dag.json`, which eslint-plugin-boundaries also reads).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = join(workspaceRoot, "docs", "PROJECT_MAP.md");
const README_PATH = join(workspaceRoot, "README.md");
const MODULES_DIR = join(workspaceRoot, "apps", "core", "src", "modules");

/** Documentation keys (`$comment`) are not modules — drop them before any comparison. */
const stripComments = (o: Record<string, unknown>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("$"))) as Record<string, string[]>;

const dag = stripComments(require("../module-dag.json") as Record<string, unknown>);

/**
 * A mermaid node id may not carry a hyphen (`mcp-gateway` would be read as a `-` edge
 * token), so ids are sanitized and the readable name goes in the label.
 */
const nodeId = (module: string): string => module.replace(/[^A-Za-z0-9_]/g, "_");

/** Everything reachable from `start` by following allow-edges, `start` itself excluded. */
function reachableFrom(graph: Readonly<Record<string, readonly string[]>>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph[start] ?? [])];
  for (;;) {
    const next = stack.pop();
    if (next === undefined) break;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph[next] ?? []));
  }
  return seen;
}

/**
 * TRANSITIVE REDUCTION. `module-dag.json` spells out the allow relation in FULL —
 * `results` lists all nine modules below it — because eslint-plugin-boundaries needs
 * every permitted target enumerated. Drawn literally, that allow-list is several times
 * denser than the shape it encodes: a picture nobody can read, which is the same as no
 * picture. The exact size is counted from the file by the suite below, never typed here,
 * because a hand-typed count is the thing that rots (the map shipped "61 edges" against
 * a file holding 71).
 *
 * An edge `from -> to` is dropped when `from` has another direct target that already
 * reaches `to`, i.e. when the edge adds no permission the rest of the graph does not
 * already imply. What survives is the shape of the DAG; what is removed is still
 * allowed, by following the arrows.
 */
export function directEdges(graph: Readonly<Record<string, readonly string[]>>): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const from of Object.keys(graph)) {
    const targets = graph[from] ?? [];
    const reach = new Map<string, Set<string>>(targets.map((t) => [t, reachableFrom(graph, t)]));
    for (const to of targets) {
      const implied = targets.some((mid) => mid !== to && (reach.get(mid)?.has(to) ?? false));
      if (!implied) edges.push([from, to]);
    }
  }
  return edges;
}

/**
 * Renders the fenced ```mermaid block the map must contain, character for character.
 * Node order and edge order follow `module-dag.json`'s own key order, so the output is
 * a pure function of that file — regenerating it twice can never produce a diff.
 */
export function mermaidFromDag(graph: Readonly<Record<string, readonly string[]>>): string {
  const lines = ["```mermaid", "graph TD"];
  for (const module of Object.keys(graph)) lines.push(`  ${nodeId(module)}["${module}"]`);
  lines.push("");
  for (const [from, to] of directEdges(graph)) lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
  lines.push("```");
  return lines.join("\n");
}

function readMap(): string {
  if (!existsSync(MAP_PATH)) {
    throw new Error(
      `docs/PROJECT_MAP.md is missing. It is the structure map every module block below is checked against; recreate it rather than deleting this gate.`,
    );
  }
  return readFileSync(MAP_PATH, "utf8");
}

/** Module directories actually present under apps/core/src/modules. */
const modulesOnDisk = (): string[] =>
  readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

/** Every `### <name>` heading in the map — the block convention the gate keys on. */
const blocksInMap = (markdown: string): string[] =>
  markdown
    .split("\n")
    .map((line) => /^### (\S+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);

/** The first fenced mermaid block, fences included. */
function extractMermaidBlock(markdown: string): string {
  const start = markdown.indexOf("```mermaid");
  expect(start, "PROJECT_MAP.md has no ```mermaid block").toBeGreaterThanOrEqual(0);
  const end = markdown.indexOf("\n```", start + "```mermaid".length);
  expect(end, "the ```mermaid block in PROJECT_MAP.md is never closed").toBeGreaterThanOrEqual(0);
  return markdown.slice(start, end + "\n```".length);
}

describe("docs/PROJECT_MAP.md covers every module", () => {
  it("has a block for every module directory on disk", () => {
    const blocks = new Set(blocksInMap(readMap()));
    for (const module of modulesOnDisk()) {
      expect(blocks.has(module), `apps/core/src/modules/${module} exists but PROJECT_MAP.md has no "### ${module}" block`).toBe(true);
    }
  });

  it("has a block for every module-dag.json key", () => {
    const blocks = new Set(blocksInMap(readMap()));
    for (const module of Object.keys(dag)) {
      expect(blocks.has(module), `module-dag.json declares "${module}" but PROJECT_MAP.md has no "### ${module}" block`).toBe(true);
    }
  });

  it("has no block for a module that exists in neither the DAG nor the source tree", () => {
    const known = new Set([...Object.keys(dag), ...modulesOnDisk()]);
    for (const block of blocksInMap(readMap())) {
      expect(known.has(block), `PROJECT_MAP.md documents "### ${block}", which is neither a module-dag.json key nor a directory under apps/core/src/modules`).toBe(true);
    }
  });
});

describe("the mermaid graph is generated, not drawn", () => {
  it("matches the block regenerated from module-dag.json", () => {
    expect(extractMermaidBlock(readMap())).toBe(mermaidFromDag(dag));
  });

  it("drops an edge another path already implies", () => {
    // c is allowed from a both directly and via b, so only the two shape-carrying edges survive.
    const edges = directEdges({ a: ["b", "c"], b: ["c"], c: [] });
    expect(edges).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
  });

  it("keeps two independent edges that imply nothing about each other", () => {
    expect(directEdges({ a: ["b", "c"], b: [], c: [] })).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
  });

  it("renders a hyphenated module under an id mermaid can parse", () => {
    const graph = mermaidFromDag({ results: [], "mcp-gateway": ["results"] });
    expect(graph).toContain('mcp_gateway["mcp-gateway"]');
    expect(graph).toContain("mcp_gateway --> results");
  });
});

/** Strips combining marks so Vietnamese prose can be matched by an ASCII pattern. */
const deaccent = (text: string): string => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Size of the FULL allow relation: every target every module is permitted to import. */
const totalEdges = (graph: Readonly<Record<string, readonly string[]>>): number =>
  Object.values(graph).reduce((sum, targets) => sum + targets.length, 0);

/**
 * The reduced picture is only justified by how big the unreduced one would be, so the map
 * states that size in prose — a claim about `module-dag.json` that nothing was checking.
 * It was wrong on arrival ("61 edges" against a file holding 71), in the one paragraph
 * whose job is to describe the DAG exactly. The map is Vietnamese and this tree must stay
 * English, so the prose is deaccented before matching rather than quoted with its marks.
 */
describe("the map counts the allow-list instead of quoting a remembered number", () => {
  it("states the edge and node totals module-dag.json actually holds", () => {
    const match = /(\d+) canh tren (\d+) nut/.exec(deaccent(readMap()));
    if (match === null) {
      throw new Error(
        'PROJECT_MAP.md no longer states the full allow-list size as "<N> canh tren <M> nut". That sentence is what justifies drawing a reduced graph; keep it, or move this gate to whatever replaced it.',
      );
    }
    expect(Number(match[1]), "PROJECT_MAP.md states an edge count module-dag.json does not hold").toBe(totalEdges(dag));
    expect(Number(match[2]), "PROJECT_MAP.md states a module count module-dag.json does not hold").toBe(Object.keys(dag).length);
  });
});

describe("README.md keeps the map reachable", () => {
  it("links to docs/PROJECT_MAP.md", () => {
    expect(
      readFileSync(README_PATH, "utf8"),
      "README.md is the entry document; a map nothing links to is a map nobody opens",
    ).toContain("docs/PROJECT_MAP.md");
  });
});
