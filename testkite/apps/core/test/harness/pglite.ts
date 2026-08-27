/**
 * Harness test DB — PGlite in-process.
 *
 * VÌ SAO PGlite chứ không Testcontainers: sandbox/CI runner không đảm bảo có
 * docker daemon (spike 2026-08-27: /var/run/docker.sock không tồn tại).
 * GIỚI HẠN ĐÃ BIẾT: PGlite chỉ có MỘT connection — mọi transaction xếp hàng
 * tuần tự, KHÔNG có lock contention. Test race/lease/SKIP LOCKED phải dùng
 * Postgres thật, xem test/harness/realpg.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { TkDb } from "../../src/modules/kernel/db/types.js";

export type TestDb = {
  readonly db: TkDb;
  readonly raw: PGlite;
  readonly reset: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function makeTestDb(): Promise<TestDb> {
  const raw = await new PGlite();
  const db = drizzle(raw) as unknown as TkDb;
  return {
    db,
    raw,
    // Spike: TRUNCATE ~2ms vs new PGlite() ~2.3s — luôn reset, không dựng lại.
    reset: async () => {
      const r = await raw.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'`,
      );
      if (r.rows.length === 0) return;
      const names = r.rows.map((x) => `"${x.t}"`).join(", ");
      await raw.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    },
    close: async () => {
      await raw.close();
    },
  };
}
