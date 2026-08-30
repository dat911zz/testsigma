/**
 * Reading rows off a raw-SQL result, without a blind cast.
 *
 * `TkDb`/`TkTx` are deliberately driver-agnostic (`PgDatabase<PgQueryResultHKT>`) so the same
 * service code runs on node-postgres (CI/prod) and on PGlite (unit tests) — the price is that
 * `execute()` is typed `unknown`. Casting it with `as` would hand every caller a type the
 * driver never promised; these guards throw on a shape neither driver produces instead of
 * silently reading garbage out of it.
 */
export type SqlRow = Record<string, unknown>;

export const isSqlRow = (v: unknown): v is SqlRow =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Both node-postgres and PGlite answer `{ rows: [...] }`; anything else is a bug, not a row. */
export function rowsOf(result: unknown): readonly SqlRow[] {
  if (!isSqlRow(result)) throw new Error("sql: query result is not an object");
  const rows: unknown = result["rows"];
  if (!Array.isArray(rows)) throw new Error("sql: query result is missing a rows array");
  const list: readonly unknown[] = rows;
  return list.filter(isSqlRow);
}

/**
 * The first row, or `undefined` for an empty result — the shape every conditional write in
 * this codebase reads, because "RETURNING gave nothing back" IS the answer there (0 rows =>
 * over quota / stale epoch / another tenant), not an error.
 */
export function firstRow(result: unknown): SqlRow | undefined {
  return rowsOf(result)[0];
}
