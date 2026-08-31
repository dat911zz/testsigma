/**
 * A table that names a key the DTO does not have — a field renamed on one side only, or a leftover
 * from a deleted field. Expected: TS2353.
 */
import type { FieldMap } from "@testkite/contract";

interface SrcDto {
  id: string;
  name: string;
}

interface Dst {
  readonly id: string;
  readonly name: string;
}

export const unknownKey = { id: "id", name: "name", ghost: "id" } satisfies FieldMap<SrcDto, Dst>;
