/**
 * Kiểu DB dùng chung, KHÔNG gắn driver: cùng một hàm chạy được trên
 * node-postgres (prod/CI) lẫn PGlite (unit test).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type TkDb = PgDatabase<PgQueryResultHKT>;
export type TkTx = Parameters<Parameters<TkDb["transaction"]>[0]>[0];

/** Bối cảnh tenant — L1 fail-closed: không có nó thì không có query nào chạy. */
export type TenantContext = {
  readonly teamId: string;
};
