/**
 * `FieldMap<Src, Dst>` — compile-time proof that an adapter LOOKED AT every field of the DTO it
 * rebuilds.
 *
 * WHY A REBUILD NEEDS A GUARD AT ALL: the contract writes every optional as `?: T | undefined`
 * (the shape zod infers) while the domain writes `?: T`. Under `exactOptionalPropertyTypes` those
 * are not assignable, so the boundary cannot be a cast — and a cast would be a promise that the
 * two shapes never drift, which is exactly the promise nobody can keep. The rebuild is right;
 * what was missing is a fence around it.
 *
 * HOW: the keys are `keyof Required<Src>` with `-?`, so an OPTIONAL DTO field becomes a REQUIRED
 * table entry. Add a field to the DTO and the table is incomplete: `satisfies` fails with TS1360
 * and names it. The value is the DESTINATION key rather than `true`, so the table also states
 * where the field goes, and `keyof Dst` checks that the destination exists (TS2322 if it does
 * not); a key that is not on the DTO is TS2353. `null` means "deliberately not carried", and the
 * reason belongs in a comment beside it.
 *
 * WHAT THIS DOES NOT PROVE: data flow. Nothing here forces the function BODY to copy a field the
 * table names — that half is fenced by pinning the set of `null` entries in a test per app
 * (apps/core/test/arch/adapter-guard.test.ts, apps/runner/test/arch/field-map-drops.test.ts), so
 * dropping a field silently would have to edit a test as well. It also does not replace the
 * contract-conformance tests: it measures SHAPE, not meaning.
 *
 * TYPE-ONLY BY DESIGN: no runtime value lives in this module, so it cannot appear in
 * `OPENAPI_SCHEMA_NAMES` and the generated document is untouched. Codes and behaviour measured
 * 2026-08-31 with tsc 5.7.3 and pinned by apps/core/test/arch/adapter-guard.test.ts.
 */
export type FieldMap<Src, Dst> = { readonly [K in keyof Required<Src>]-?: keyof Dst | null };
