/**
 * Shared DB type, NOT bound to a driver: the same function can run on
 * node-postgres (prod/CI) as well as PGlite (unit test).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type TkDb = PgDatabase<PgQueryResultHKT>;
export type TkTx = Parameters<Parameters<TkDb["transaction"]>[0]>[0];

/** Tenant context — L1 fail-closed: without it, no query runs. */
export type TenantContext = {
  readonly teamId: string;
};
