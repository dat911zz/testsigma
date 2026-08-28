/**
 * Bridges the API shape (a nested step tree, no ordinals) and the DB shape (a flat table
 * with parent_step_id + ordinal) — and between the DB and the revision payload (flat,
 * position via `after`). PURE: anything non-deterministic (new ids) is injected in.
 */
import type { StepInputDto, StepKindDto } from "@testkite/contract";
import type { RevisionCase, RevisionPayload, RevisionStep } from "./revision/payload.js";

export interface StepRow {
  readonly id: string;
  readonly caseId: string;
  readonly parentStepId: string | null;
  readonly ordinal: number;
  readonly kind: StepKindDto;
  readonly renderedSentence: string;
  readonly verbOpKey: string | null;
  readonly elementId: string | null;
  readonly args: Record<string, string> | null;
  readonly stepGroupCaseId: string | null;
  readonly conditionExpected: string[] | null;
}

export interface LoopRow {
  readonly stepId: string;
  readonly dataProfileId: string | null;
  readonly maxIterations: number | null;
}

export interface RestRow {
  readonly stepId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string> | null;
  readonly body: string | null;
  readonly storeAs: string | null;
}

export interface FlattenInput {
  readonly caseId: string;
  readonly steps: readonly StepInputDto[];
  /** step ids CURRENTLY belonging to this case — only ids in this set may be reused. */
  readonly existingIds: ReadonlySet<string>;
  readonly newId: () => string;
}

export interface FlattenResult {
  readonly steps: StepRow[];
  readonly loops: LoopRow[];
  readonly rests: RestRow[];
}

export function flattenStepInputs(input: FlattenInput): FlattenResult {
  const steps: StepRow[] = [];
  const loops: LoopRow[] = [];
  const rests: RestRow[] = [];
  const used = new Set<string>();

  const resolveId = (candidate: string | undefined): string => {
    // A foreign id (from another case / tenant / made up) may NOT be reused: it's both a
    // tenant hole and a way for the diff to lie about the step's identity.
    if (candidate !== undefined && input.existingIds.has(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    return input.newId();
  };

  const walk = (nodes: readonly StepInputDto[], parentStepId: string | null): void => {
    let ordinal = 0;
    for (const node of nodes) {
      ordinal += 1;
      const id = resolveId(node.id);
      const base = {
        id,
        caseId: input.caseId,
        parentStepId,
        ordinal,
        kind: node.kind,
        renderedSentence: node.renderedSentence,
        verbOpKey: null,
        elementId: null,
        args: null,
        stepGroupCaseId: null,
        conditionExpected: null,
      } satisfies StepRow;

      switch (node.kind) {
        case "action":
          steps.push({
            ...base,
            verbOpKey: node.verbOpKey,
            elementId: node.elementId ?? null,
            args: node.args ?? null,
          });
          break;
        case "step_group":
          steps.push({ ...base, stepGroupCaseId: node.stepGroupCaseId });
          break;
        case "if":
          steps.push({ ...base, conditionExpected: [...node.conditionExpected] });
          walk(node.children, id);
          break;
        case "for":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: node.loopDataProfileId, maxIterations: null });
          walk(node.children, id);
          break;
        case "while":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: null, maxIterations: node.maxIterations ?? null });
          walk(node.children, id);
          break;
        case "rest":
          steps.push(base);
          rests.push({
            stepId: id,
            method: node.method,
            url: node.url,
            headers: node.headers ?? null,
            body: node.body ?? null,
            storeAs: node.storeAs ?? null,
          });
          break;
      }
    }
  };

  walk(input.steps, null);
  return { steps, loops, rests };
}

export interface BuildPayloadInput {
  readonly case: RevisionCase;
  readonly steps: readonly StepRow[];
  readonly loops: readonly LoopRow[];
  readonly rests: readonly RestRow[];
}

/**
 * Builds the revision payload. Two rules:
 *   1. Position = `after` (the id of the immediately preceding sibling), NOT ordinal — see
 *      diff.ts for why (noise-measurement spike, 2026-08-28).
 *   2. A field with no value is OMITTED entirely from the object, never set to null: the
 *      canonical hash must depend only on the data, never on how the object was built.
 *
 * Does NOT re-sort `input.steps`: it already arrives in pre-order from
 * `flattenStepInputs`, and within each sibling group the ordinal increases — so "the
 * preceding sibling" is simply the nearest step with the same parent. Re-sorting by a
 * GLOBAL ordinal would interleave sibling groups and corrupt a child step's `after`.
 */
export function buildRevisionPayload(input: BuildPayloadInput): RevisionPayload {
  const loopByStep = new Map(input.loops.map((l) => [l.stepId, l]));
  const restByStep = new Map(input.rests.map((r) => [r.stepId, r]));
  const lastSiblingOf = new Map<string | null, string | null>();

  const steps: RevisionStep[] = [];
  for (const row of input.steps) {
    const after = lastSiblingOf.get(row.parentStepId) ?? null;
    lastSiblingOf.set(row.parentStepId, row.id);
    const loop = loopByStep.get(row.id);
    const rest = restByStep.get(row.id);
    steps.push({
      id: row.id,
      kind: row.kind,
      parentId: row.parentStepId,
      after,
      renderedSentence: row.renderedSentence,
      ...(row.verbOpKey === null ? {} : { verbOpKey: row.verbOpKey }),
      ...(row.elementId === null ? {} : { elementId: row.elementId }),
      ...(row.args === null ? {} : { args: row.args }),
      ...(row.stepGroupCaseId === null ? {} : { stepGroupCaseId: row.stepGroupCaseId }),
      ...(row.conditionExpected === null ? {} : { conditionExpected: row.conditionExpected }),
      ...(loop === undefined
        ? {}
        : {
            loop: {
              ...(loop.dataProfileId === null ? {} : { dataProfileId: loop.dataProfileId }),
              ...(loop.maxIterations === null ? {} : { maxIterations: loop.maxIterations }),
            },
          }),
      ...(rest === undefined
        ? {}
        : {
            rest: {
              method: rest.method,
              url: rest.url,
              ...(rest.headers === null ? {} : { headers: rest.headers }),
              ...(rest.body === null ? {} : { body: rest.body }),
              ...(rest.storeAs === null ? {} : { storeAs: rest.storeAs }),
            },
          }),
    });
  }
  return { case: input.case, steps };
}
