/**
 * The POSITIVE half of the `FieldMap` proof, checked under the repo's REAL tsconfig rather than
 * the compiler options `apps/core/test/arch/adapter-guard.test.ts` synthesizes: `packages/contract`
 * typechecks `src/**`, this file included, so a table below that stopped satisfying the type would
 * turn `pnpm typecheck` red.
 *
 * The NEGATIVE half — that a missing field, a bad destination and an unknown key really are
 * errors — cannot live here: a file that fails to compile cannot also run assertions. It lives in
 * apps/core/test/arch/adapter-guard.test.ts, which runs `tsc` over fixtures on purpose.
 */
import { describe, expect, it } from "vitest";
import type { FieldMap } from "./field-map.js";

interface SrcDto {
  id: string;
  name: string;
  note?: string | undefined;
}

interface Dst {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
}

/** Renaming across the boundary is the normal case, so the value is a destination key. */
const renaming = { id: "id", name: "label", note: "note" } satisfies FieldMap<SrcDto, Dst>;

/** A field looked at and deliberately left behind. */
const dropping = { id: "id", name: "label", note: null } satisfies FieldMap<SrcDto, Dst>;

describe("FieldMap", () => {
  it("keeps an optional DTO field as a REQUIRED table entry", () => {
    // `note` is optional on the DTO; the type made it mandatory here, which is the whole point.
    expect(Object.keys(renaming).sort()).toEqual(["id", "name", "note"]);
  });

  it("carries the destination key, so a table states where each field goes", () => {
    expect(renaming.name).toBe("label");
  });

  it("spells a deliberate drop as null, the one shape a tier-2 test can count", () => {
    expect(dropping.note).toBeNull();
  });
});
