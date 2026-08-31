/**
 * TIER 2, the runner's half of the fleet boundary.
 *
 * Tier 1 — the `satisfies FieldMap<…>` inside `worker.ts` — is enforced by `pnpm -r typecheck`
 * (`apps/runner/package.json` runs `tsc -p tsconfig.json --noEmit` over `src`) and proves every
 * DTO field was LOOKED AT. It cannot prove the body copies what a table names, so the only way to
 * say "looked at, not carried" — a `null` entry — is pinned here.
 *
 * WHY THIS FILE EXISTS SEPARATELY from apps/core/test/arch/adapter-guard.test.ts: the two apps are
 * peers with no dependency between them (`apps/core/node_modules/@testkite` holds only `contract`
 * and `run-compiler`, and there is no `node_modules/@testkite` at the workspace root), so a core
 * test cannot resolve this module at all. The helper below is duplicated for the same reason —
 * sharing it would mean a runtime export in @testkite/contract, and `field-map.ts` is deliberately
 * type-only.
 */
import { describe, expect, it } from "vitest";
import { COMPLETED_STEP_FIELDS } from "../../src/worker.js";

/** Every `null` entry of a flat map, sorted. `null` is the only shape a drop can take. */
const drops = (map: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.entries(map)
    .filter(([, value]) => value === null)
    .map(([key]) => key)
    .sort();

describe("COMPLETED_STEP_FIELDS (tier 2)", () => {
  it("drops exactly the fields this list names, and nothing else", () => {
    expect(drops(COMPLETED_STEP_FIELDS)).toEqual([
      // TODO(M4): no ThumbHash encoder in this image, so the field travels as an explicit null
      // instead of being implied by the contract default.
      "thumbhash",
    ]);
  });
});
