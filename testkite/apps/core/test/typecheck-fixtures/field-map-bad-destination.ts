/**
 * A table that sends a field to a destination key the domain type does not have. Expected: TS2322.
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

export const badDestination = { id: "id", name: "nope" } satisfies FieldMap<SrcDto, Dst>;
