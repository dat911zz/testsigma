/**
 * The same drift on the wire DTO that BOTH fleet-boundary tables consume — the runner reads it as
 * `z.input`, the control plane as `z.infer`, and `keyof Required<Src>` erases the difference
 * between the two (the fields carrying a `.default()`). So this one fixture covers the drift case
 * for `COMPLETED_STEP_FIELDS` in apps/runner as well, which is why apps/runner needs no `tsc`
 * fixture rig of its own. Expected: TS1360, naming `retriedFrom`.
 *
 * An INTERSECTION, not `interface … extends`: `z.infer` of a ZodObject is a mapped type, and an
 * interface may only extend an object type with statically known members. The intersection has no
 * such restriction and yields the same key set. (`AuthoredCaseDto` is a hand-written interface,
 * which is why the fixture beside this one can use `extends`.)
 */
import type { completedStepSchema, FieldMap } from "@testkite/contract";
import type { z } from "zod";
import type { StepResultInput } from "../../src/modules/results/index.js";

type CompletedStepDto = z.infer<typeof completedStepSchema>;
type CompletedStepDtoNext = CompletedStepDto & { readonly retriedFrom?: number | undefined };

/** Copied verbatim from `STEP_RESULT_FIELDS` (apps/core/src/http/internal/routes.ts). */
export const stale = {
  caseId: null,
  ordinal: "ordinal",
  execSeq: "execSeq",
  loopPath: "loopPath",
  status: "verdict",
  durationMs: "durationMs",
  renderedSentence: "renderedSentence",
  failureContext: "failureContext",
  screenshotArtifactId: "screenshotArtifactId",
  thumbhash: "thumbhash",
} satisfies FieldMap<CompletedStepDtoNext, StepResultInput>;
