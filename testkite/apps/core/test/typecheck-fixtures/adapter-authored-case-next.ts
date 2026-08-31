/**
 * The same drift, on the REAL contract DTO instead of a toy pair: `AuthoredCaseDto` gains one
 * optional field tomorrow and `toAuthoredCase`'s table stays as it is today. Expected: TS1360,
 * naming `ownerId`.
 *
 * The map below is copied VERBATIM from `ADAPTER_FIELD_MAPS.authoredCase`
 * (apps/core/src/modules/orchestration/run-service.ts). Copying rather than importing is
 * deliberate: importing today's table would make this fixture change meaning the day the table
 * changes, and the thing under test is the TYPE, not the current table's contents.
 */
import type { AuthoredCaseDto, FieldMap } from "@testkite/contract";
import type { AuthoredCase } from "@testkite/run-compiler";

/** What "the contract adds a field tomorrow" looks like. */
interface AuthoredCaseDtoNext extends AuthoredCaseDto {
  ownerId?: string | undefined;
}

export const stale = {
  id: "id",
  revisionId: "revisionId",
  name: "name",
  isStepGroup: "isStepGroup",
  prereqCaseId: "prereqCaseId",
  dataProfileId: "dataProfileId",
  steps: "steps",
} satisfies FieldMap<AuthoredCaseDtoNext, AuthoredCase>;
