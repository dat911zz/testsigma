/**
 * Builds the `CompileSnapshot` — the ONLY input to @testkite/run-compiler.
 * The compiler is a PURE function, no I/O: everything it needs must already be fetched here.
 *
 * MODULE BOUNDARY (blueprint §4, one-way DAG):
 *   - elements/testdata sit BEFORE authoring ⇒ calling them is allowed, but M2 doesn't
 *     have those two modules yet so they come in through an INJECTION PORT (SnapshotDeps). M4 wires up the real facade.
 *   - planning (pln_environments) sits AFTER authoring ⇒ import is FORBIDDEN. So `env` is a
 *     PARAMETER loaded by orchestration (phase 0) and passed down.
 */
import type {
  AuthoredCaseDto,
  AuthoredStepDto,
  CompileSnapshotDto,
  DataProfileDto,
  ElementDto,
  EnvDto,
} from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo } from "./db/case-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { CaseNotFoundError, CaseStateError } from "./errors.js";
import type { RevisionPayload, RevisionStep } from "./revision/payload.js";

export type SnapshotPin = "ready" | "latest";

export interface SnapshotDeps {
  readonly loadElements: (ids: readonly string[]) => Promise<Record<string, ElementDto>>;
  readonly loadDataProfiles: (ids: readonly string[]) => Promise<Record<string, DataProfileDto>>;
  readonly env: EnvDto;
}

export interface SnapshotInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly pin: SnapshotPin;
}

/** Hard cap when closing over prereqs + step groups. Exceeding it = bad data, not just a big case. */
export const MAX_SNAPSHOT_CASES = 200;

/** Rebuilds the step TREE from the flat list (parentId + after) and renumbers ordinals from 1. */
function toAuthoredSteps(steps: readonly RevisionStep[], parentId: string | null): AuthoredStepDto[] {
  const siblings = steps.filter((s) => s.parentId === parentId);
  // `after` is a singly-linked list: start from the element whose after = null.
  const byAfter = new Map<string | null, RevisionStep>();
  for (const s of siblings) byAfter.set(s.after, s);

  const ordered: RevisionStep[] = [];
  let cursor = byAfter.get(null);
  const guard = siblings.length + 1;
  while (cursor !== undefined && ordered.length < guard) {
    ordered.push(cursor);
    cursor = byAfter.get(cursor.id);
  }
  // Corrupt payload (cycle / broken link): keep what we could rebuild, append the rest.
  for (const s of siblings) if (!ordered.includes(s)) ordered.push(s);

  return ordered.map((s, i): AuthoredStepDto => {
    const ordinal = i + 1;
    switch (s.kind) {
      case "action":
        return {
          kind: "action",
          ordinal,
          renderedSentence: s.renderedSentence,
          verbOpKey: s.verbOpKey ?? "",
          ...(s.args === undefined ? {} : { args: s.args }),
          ...(s.elementId === undefined ? {} : { elementId: s.elementId }),
        };
      case "step_group":
        return {
          kind: "step_group",
          ordinal,
          renderedSentence: s.renderedSentence,
          stepGroupCaseId: s.stepGroupCaseId ?? "",
        };
      case "if":
        return {
          kind: "if",
          ordinal,
          renderedSentence: s.renderedSentence,
          conditionExpected: [...(s.conditionExpected ?? [])],
          children: toAuthoredSteps(steps, s.id),
        };
      case "for":
        return {
          kind: "for",
          ordinal,
          renderedSentence: s.renderedSentence,
          loopDataProfileId: s.loop?.dataProfileId ?? "",
          children: toAuthoredSteps(steps, s.id),
        };
      case "while":
        return {
          kind: "while",
          ordinal,
          renderedSentence: s.renderedSentence,
          ...(s.loop?.maxIterations === undefined ? {} : { maxIterations: s.loop.maxIterations }),
          children: toAuthoredSteps(steps, s.id),
        };
      case "rest":
        return {
          kind: "rest",
          ordinal,
          renderedSentence: s.renderedSentence,
          // The DB's REST fields (method/url/headers/body/storeAs) flatten into the contract's
          // `args` — headers travel as a JSON string because args is Record<string,string>.
          args: {
            ...(s.rest === undefined
              ? {}
              : {
                  method: s.rest.method,
                  url: s.rest.url,
                  ...(s.rest.headers === undefined ? {} : { headers: JSON.stringify(s.rest.headers) }),
                  ...(s.rest.body === undefined ? {} : { body: s.rest.body }),
                  ...(s.rest.storeAs === undefined ? {} : { store: s.rest.storeAs }),
                }),
          },
        };
    }
  });
}

/** Recursively counts every step reachable in a rebuilt tree — self plus all descendants. */
function countTreeSteps(nodes: readonly AuthoredStepDto[]): number {
  let total = nodes.length;
  for (const node of nodes) {
    if (node.kind === "if" || node.kind === "for" || node.kind === "while") {
      total += countTreeSteps(node.children);
    }
  }
  return total;
}

export function revisionPayloadToAuthoredCase(
  caseId: string,
  revisionId: string,
  payload: RevisionPayload,
): AuthoredCaseDto {
  const steps = toAuthoredSteps(payload.steps, null);
  // A step whose parentId points at an id absent from this revision's flat list never
  // matches any `parentId === X` filter above (X only ever ranges over `null` and ids
  // toAuthoredSteps has actually recursed into) — it silently falls out of the tree, and
  // the run-compiler would then compile and execute the case one step short with no
  // signal at all. Corrupted data must fail loud right here, not flow downstream missing a step.
  const rebuilt = countTreeSteps(steps);
  if (rebuilt !== payload.steps.length) {
    throw new Error(
      `revisionPayloadToAuthoredCase: rebuilt step tree for case ${caseId} (revision ${revisionId}) has ` +
        `${String(rebuilt)} of ${String(payload.steps.length)} steps — an orphaned parentId in the revision payload?`,
    );
  }
  return {
    id: caseId,
    revisionId,
    name: payload.case.name,
    isStepGroup: payload.case.isStepGroup,
    ...(payload.case.prereqCaseId === undefined ? {} : { prereqCaseId: payload.case.prereqCaseId }),
    ...(payload.case.dataProfileId === undefined ? {} : { dataProfileId: payload.case.dataProfileId }),
    steps,
  };
}

export async function buildCompileSnapshot(
  tx: TkTx,
  ctx: TenantContext,
  input: SnapshotInput,
  deps: SnapshotDeps,
): Promise<CompileSnapshotDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);

  const collected: Record<string, AuthoredCaseDto> = {};
  const elementIds = new Set<string>();
  const dataProfileIds = new Set<string>();
  const queue = [...input.targetCaseIds];

  while (queue.length > 0) {
    const caseId = queue.shift();
    if (caseId === undefined || caseId in collected) continue;
    if (Object.keys(collected).length >= MAX_SNAPSHOT_CASES) {
      throw new CaseStateError(
        `Case chain exceeds the cap of ${MAX_SNAPSHOT_CASES} — suspect a malformed prereq/step group graph`,
      );
    }
    const row = await cases.findById(caseId);
    // RLS already filtered out other tenants ⇒ 404, never 403 (blueprint §3 L3).
    if (row === undefined) throw new CaseNotFoundError(caseId);

    const revisionId = input.pin === "ready" ? row.readyRevisionId : row.latestRevisionId;
    if (revisionId === null) {
      throw new CaseStateError(
        input.pin === "ready"
          ? `Case ${caseId} does not have a ready revision yet — promote it before running on schedule/CI`
          : `Case ${caseId} has no revision yet`,
      );
    }
    const payload = await revisions.loadPayload(revisionId);
    const authored = revisionPayloadToAuthoredCase(caseId, revisionId, payload);
    collected[caseId] = authored;

    if (authored.prereqCaseId !== undefined) queue.push(authored.prereqCaseId);
    if (authored.dataProfileId !== undefined) dataProfileIds.add(authored.dataProfileId);
    for (const step of payload.steps) {
      if (step.elementId !== undefined) elementIds.add(step.elementId);
      if (step.stepGroupCaseId !== undefined) queue.push(step.stepGroupCaseId);
      if (step.loop?.dataProfileId !== undefined) dataProfileIds.add(step.loop.dataProfileId);
    }
  }

  // Called EXACTLY ONCE per port: an N+1 query at phase 0 is the exact class of bug that killed the legacy system.
  const elements = await deps.loadElements([...elementIds].sort());
  const dataProfiles = await deps.loadDataProfiles([...dataProfileIds].sort());

  return {
    teamId: ctx.teamId,
    projectId: input.projectId,
    targetCaseIds: [...input.targetCaseIds],
    cases: collected,
    elements,
    dataProfiles,
    env: deps.env,
  };
}
