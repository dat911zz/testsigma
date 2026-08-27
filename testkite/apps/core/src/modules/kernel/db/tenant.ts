import { sql } from "drizzle-orm";
// Ranh giới module: kernel là GỐC của DAG (module-dag.json) — nó không được import
// module nào khác, kể cả identity. APP_ROLE vì thế sống trong chính kernel, cạnh
// RELAY_ROLE (guard: eslint-boundaries + test/arch/module-boundaries.test.ts).
import { APP_ROLE } from "./schema.js";
import { assertTenantContext } from "./repo.js";
import type { TenantContext, TkDb, TkTx } from "./types.js";

/**
 * Mở transaction đã gắn tenant. Hai việc, đúng thứ tự:
 *   1. SET LOCAL ROLE testkite_app — RLS chỉ có hiệu lực với role non-superuser,
 *      non-owner (spike 2026-08-27: superuser bypass RLS kể cả khi FORCE).
 *   2. set_config('app.team_id', $1, true) — is_local=true nên tự revert khi tx đóng;
 *      truyền THAM SỐ, không bao giờ nội suy chuỗi vào SQL.
 */
export async function withTenant<T>(
  db: TkDb,
  ctx: TenantContext,
  fn: (tx: TkTx) => Promise<T>,
): Promise<T> {
  const teamId = assertTenantContext(ctx);
  return db.transaction(async (tx) => {
    // APP_ROLE là hằng compile-time của chính ta, không phải input người dùng.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.team_id', ${teamId}, true)`);
    return fn(tx);
  });
}
