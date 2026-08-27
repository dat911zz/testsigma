/**
 * Harness Postgres THẬT — dành riêng cho test cần tranh chấp khoá.
 *
 * VÌ SAO KHÔNG DÙNG PGlite Ở ĐÂY: PGlite chỉ có MỘT connection wasm; hai transaction
 * đồng thời chỉ xếp hàng tuần tự (spike 2026-08-27), nên "SKIP LOCKED disjoint" test
 * trên PGlite luôn xanh một cách vô nghĩa.
 *
 * Bật bằng biến môi trường TESTKITE_TEST_PG_URL. Không có ⇒ skip (máy dev không có
 * Postgres vẫn `pnpm test` xanh). CI luôn set biến này — xem .github/workflows.
 */
import { describe } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { TkDb } from "../../src/modules/kernel/db/types.js";

const URL_ENV = "TESTKITE_TEST_PG_URL";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export const realPgUrl = (): string | undefined => process.env[URL_ENV];

/**
 * `describe` đã gắn sẵn điều kiện skip. Điều kiện được chốt LÚC IMPORT — vitest cần
 * biết suite có chạy hay không ngay ở pha collect.
 *
 * Lệch có chủ đích so với block trong plan: bỏ annotation
 * `typeof describe.skipIf extends never ? never : typeof describe` cùng cặp
 * `as unknown as typeof describe`. `describe.skipIf()` của vitest 3 đã trả
 * `ChainableSuiteAPI` — gọi được `(name, factory)` y hệt `describe` — nên cặp cast
 * đó là cast vô cớ, thứ chuẩn code TestKite cấm. Kiểu suy ra tự động đúng và chặt hơn.
 */
export const describeRealPg = describe.skipIf(realPgUrl() === undefined);

export type RealDb = {
  readonly db: TkDb;
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
};

export async function makeRealDb(): Promise<RealDb> {
  const connectionString = realPgUrl();
  if (connectionString === undefined) throw new Error(`${URL_ENV} chưa được set`);
  const pool = new pg.Pool({ connectionString, max: 8 });
  // Cast như harness PGlite: `TkDb` cố ý driver-agnostic (`PgQueryResultHKT` chưa gắn
  // driver) nên `NodePgDatabase` không assignable trực tiếp; migrate() cũng nhận đúng
  // kiểu database gắn driver của nó.
  const db = drizzle(pool) as unknown as TkDb;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
