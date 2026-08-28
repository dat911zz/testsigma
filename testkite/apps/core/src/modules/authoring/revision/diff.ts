/**
 * Three-way diff for a revision payload. PURE — no I/O, no Date.now().
 *
 * Why WRITTEN BY HAND instead of a library (surveyed 2026-08-28):
 *   - No npm library does a REPORTING-style three-way diff; `json-diff3` (the only
 *     three-way merge library) hashes array elements with String(obj), so it hard-throws
 *     "Duplicate array key '[object Object]'" on exactly our steps shape.
 *   - Every two-way library (jsondiffpatch, rfc6902, fast-json-patch, deep-object-diff)
 *     reports 4 changes for a single step insertion; the noise-canceling normalization
 *     still has to be written by hand, after which the library is just a for-loop.
 *   - The 409 body must be a DTO with a zod schema (drift gate against OpenAPI) — the
 *     magic delta format of jsondiffpatch can't be expressed as a decent schema.
 */
import type { CaseChangeDto, ThreeWayDiffDto } from "@testkite/contract";
import { canonicalJson } from "./canonical.js";
import type { RevisionPayload } from "./payload.js";

export interface FlatRevision {
  /** path -> canonical JSON of the value. E.g. "/name" -> "\"Checkout\"". */
  readonly scalars: ReadonlyMap<string, string>;
  /** stepId -> (field -> canonical JSON). */
  readonly steps: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const CASE_FIELDS = ["name", "isStepGroup", "prereqCaseId", "dataProfileId"] as const;
const STEP_FIELDS = [
  "kind",
  "parentId",
  "after",
  "renderedSentence",
  "verbOpKey",
  "elementId",
  "args",
  "stepGroupCaseId",
  "conditionExpected",
  "loop",
  "rest",
] as const;

export function flattenRevision(payload: RevisionPayload): FlatRevision {
  const scalars = new Map<string, string>();
  for (const field of CASE_FIELDS) {
    const value = payload.case[field];
    if (value === undefined) continue;
    scalars.set(`/${field}`, canonicalJson(value));
  }
  const steps = new Map<string, ReadonlyMap<string, string>>();
  for (const step of payload.steps) {
    const fields = new Map<string, string>();
    for (const field of STEP_FIELDS) {
      const value = step[field];
      if (value === undefined) continue;
      fields.set(field, canonicalJson(value));
    }
    steps.set(step.id, fields);
  }
  return { scalars, steps };
}

/** Only used for the DTO's `base`/`value` — returns the parsed value, not the JSON string. */
function parse(json: string | undefined): unknown {
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}

function change(path: string, kind: CaseChangeDto["kind"], base?: string, value?: string): CaseChangeDto {
  const out: CaseChangeDto = { path, kind };
  const b = parse(base);
  const v = parse(value);
  // exactOptionalPropertyTypes: explicitly assigning undefined is a type error — only assign when present.
  return {
    ...out,
    ...(b === undefined ? {} : { base: b }),
    ...(v === undefined ? {} : { value: v }),
  };
}

/** Compares two flat revisions. Add/remove is reported at STEP level; edits at FIELD level. */
export function diffFlat(a: FlatRevision, b: FlatRevision): CaseChangeDto[] {
  const out: CaseChangeDto[] = [];

  for (const path of new Set([...a.scalars.keys(), ...b.scalars.keys()])) {
    const x = a.scalars.get(path);
    const y = b.scalars.get(path);
    if (x === y) continue;
    if (x === undefined) out.push(change(path, "added", undefined, y));
    else if (y === undefined) out.push(change(path, "removed", x, undefined));
    else out.push(change(path, "modified", x, y));
  }

  for (const id of new Set([...a.steps.keys(), ...b.steps.keys()])) {
    const x = a.steps.get(id);
    const y = b.steps.get(id);
    if (x !== undefined && y === undefined) {
      out.push({ path: `/steps/${id}`, kind: "removed", base: rebuild(x) });
      continue;
    }
    if (x === undefined && y !== undefined) {
      out.push({ path: `/steps/${id}`, kind: "added", value: rebuild(y, id) });
      continue;
    }
    if (x === undefined || y === undefined) continue;
    for (const field of new Set([...x.keys(), ...y.keys()])) {
      const fx = x.get(field);
      const fy = y.get(field);
      if (fx === fy) continue;
      const path = `/steps/${id}/${field}`;
      if (fx === undefined) out.push(change(path, "added", undefined, fy));
      else if (fy === undefined) out.push(change(path, "removed", fx, undefined));
      else out.push(change(path, "modified", fx, fy));
    }
  }

  // Stable order: the 409 body must be identical across two runs (test + client cache).
  return out.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
}

/** Rebuilds a step object from the flat form to place in `base`/`value` for an added/removed entry. */
function rebuild(fields: ReadonlyMap<string, string>, id?: string): unknown {
  const out: Record<string, unknown> = {};
  if (id !== undefined) out["id"] = id;
  for (const [k, v] of fields) out[k] = JSON.parse(v) as unknown;
  return out;
}

export interface ThreeWayDiffInput {
  readonly base: RevisionPayload;
  readonly mine: RevisionPayload;
  readonly theirs: RevisionPayload;
  readonly baseVersion: number;
  readonly baseRevisionId: string;
  readonly currentVersion: number;
  readonly currentRevisionId: string;
}

/**
 * Conflict = a path touched by BOTH branches AND ending up with two different values.
 * If both sides made the identical edit there's nothing to decide ⇒ not a conflict.
 * A delete on one side + an edit on the other land on the same step-level path
 * `/steps/<id>` for the delete branch and a field-level path for the edit branch —
 * so compare both directions by prefix.
 */
export function threeWayDiff(input: ThreeWayDiffInput): ThreeWayDiffDto {
  const base = flattenRevision(input.base);
  const mine = diffFlat(base, flattenRevision(input.mine));
  const theirs = diffFlat(base, flattenRevision(input.theirs));

  const theirsByPath = new Map(theirs.map((c) => [c.path, c]));
  const conflicts: string[] = [];
  for (const m of mine) {
    const t = theirsByPath.get(m.path);
    if (t !== undefined) {
      if (canonicalJson(m.value) !== canonicalJson(t.value)) conflicts.push(m.path);
      continue;
    }
    // This branch deletes the whole step, the other branch edits a field inside it (or vice versa).
    if (m.kind === "removed" && theirs.some((c) => c.path.startsWith(`${m.path}/`))) {
      conflicts.push(m.path);
    }
  }
  for (const t of theirs) {
    if (t.kind !== "removed") continue;
    if (conflicts.includes(t.path)) continue;
    if (mine.some((c) => c.path.startsWith(`${t.path}/`))) conflicts.push(t.path);
  }

  return {
    baseVersion: input.baseVersion,
    baseRevisionId: input.baseRevisionId,
    currentVersion: input.currentVersion,
    currentRevisionId: input.currentRevisionId,
    mine,
    theirs,
    conflicts: conflicts.sort(),
  };
}
