/**
 * NEGATIVE CONTROL: a complete map, and a deliberate drop written as `null`. Neither may produce
 * a diagnostic. If this file ever reports something, every other fixture in this directory proves
 * nothing — the program would be broken rather than the table.
 */
import type { FieldMap } from "@testkite/contract";

interface SrcDto {
  id: string;
  name: string;
  note?: string | undefined;
}

interface Dst {
  readonly id: string;
  readonly name: string;
  readonly note?: string;
}

export const complete = { id: "id", name: "name", note: "note" } satisfies FieldMap<SrcDto, Dst>;

/** "Looked at, deliberately not carried" — the only shape a drop is allowed to take. */
export const droppedOnPurpose = { id: "id", name: "name", note: null } satisfies FieldMap<SrcDto, Dst>;
