/**
 * The case the whole guard exists for: the DTO gained an OPTIONAL field and the table was not
 * updated. Expected: TS1360, naming `ownerId`.
 */
import type { FieldMap } from "@testkite/contract";

interface SrcDto {
  id: string;
  name: string;
  note?: string | undefined;
  ownerId?: string | undefined;
}

interface Dst {
  readonly id: string;
  readonly name: string;
  readonly note?: string;
  readonly ownerId?: string;
}

export const stale = { id: "id", name: "name", note: "note" } satisfies FieldMap<SrcDto, Dst>;
