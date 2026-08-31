/**
 * The DEPLOYMENT-level half of tenant isolation.
 *
 * RLS fences a session that has `SET ROLE`d to testkite_app. It does NOT fence the LOGIN role
 * that session arrived on: job_runs carries `tenant_isolation TO testkite_app` next to
 * `dispatch_all TO testkite_dispatch USING (true)`, permissive policies are OR-ed across the
 * roles the current role belongs to, and so a login that INHERITS both reads every team's rows —
 * measured 2026-08-31, both teams returned with app.team_id pinned to one of them.
 *
 * WHAT THE FIX IS NOT: forbidding the membership. apps/core opens ONE pool and `SET LOCAL ROLE`s
 * to app / auth / dispatch (tenant.ts), so its login MUST be a member of all three or `SET ROLE`
 * fails outright. The fix is that the login inherits NOTHING: it then carries no privilege of its
 * own, and a statement that forgets `withTenant` gets `permission denied for table` instead of a
 * cross-tenant read.
 *
 * INHERITANCE LIVES ON THE GRANT, NOT ON THE ROLE. PostgreSQL 16 moved it to
 * `pg_auth_members.inherit_option`; `pg_roles.rolinherit` is now only the DEFAULT applied to
 * grants made afterwards. Measured 2026-08-31: a login created INHERIT, granted the two roles,
 * then `ALTER ROLE ... NOINHERIT` reports `rolinherit = false` AND STILL READS EVERY TEAM. A
 * checker that believed `rolinherit` would wave through the single most likely remediation
 * attempt, so this one never reads that column — it judges edges.
 *
 * TRANSITIVITY IS NOT OPTIONAL: a two-hop grant (login -> some_ops_role -> testkite_dispatch) is
 * invisible to a direct-edge query, which is why the closure below is recursive. A path carries
 * privileges only when EVERY edge on it inherits (measured on the privilege itself, both hops,
 * 2026-08-31), so a path is blocked as soon as one edge says otherwise — and a role is only safe
 * when EVERY path to it is blocked.
 *
 * Membership is counted regardless of `inherit_option`, because `GRANT ... WITH INHERIT FALSE`
 * still allows `SET ROLE`; that is why INV-2 (a sub-role holding another sub-role) is reported no
 * matter what the edge says, while INV-1 is about inheritance alone.
 *
 * REQUIRES PostgreSQL 16+ for `pg_auth_members.inherit_option` (CI and production run 17).
 */
import { sql } from "drizzle-orm";
import { APP_ROLE, AUTH_ROLE, DISPATCH_ROLE, RELAY_ROLE } from "./schema.js";
import { rowsOf } from "./rows.js";
import type { TkDb } from "./types.js";

/** The four roles the migrations create. None of them can log in. */
export const TESTKITE_SUB_ROLES = [APP_ROLE, AUTH_ROLE, RELAY_ROLE, DISPATCH_ROLE] as const;

export type RoleSeparationViolationKind =
  /** INV-1 — a login role that inherits at least one testkite_* role. */
  | "inheriting_login"
  /** INV-2 — a testkite_* role that is a member of another one. */
  | "sub_role_membership"
  /** INV-3 — a login holding a testkite_* role while SUPERUSER or BYPASSRLS. */
  | "privileged_login";

export interface RoleSeparationViolation {
  readonly kind: RoleSeparationViolationKind;
  readonly role: string;
  /** The testkite_* roles this role holds, transitively, inheriting or not. */
  readonly holds: readonly string[];
  /** One sentence an operator can act on, naming the remedy that actually works. */
  readonly detail: string;
}

/**
 * `held.rolname IN (…)` with one bound parameter per role rather than an array parameter: the
 * driver-agnostic `TkDb` gives no promise about how a JS array is serialised, and this list is
 * four compile-time constants.
 */
const SUB_ROLE_LIST = sql.join(
  TESTKITE_SUB_ROLES.map((role) => sql`${role}`),
  sql`, `,
);

/**
 * One row per role that holds at least one testkite_* role, with three facts about it:
 * everything it holds, whether EVERY path to those roles is blocked, and which of them it
 * actually inherits (the ones worth naming in the fix).
 *
 * `::text` on every aggregated rolname is load-bearing, not tidiness: `pg_roles.rolname` is
 * type `name`, node-postgres registers no array parser for `name[]` (OID 1003), and the column
 * arrives as the literal string "{testkite_app,testkite_dispatch}" — which narrows to an EMPTY
 * list and would silently empty every `holds`. Caught by the two-hop test, 2026-08-31.
 */
const MEMBERSHIP_CLOSURE = sql`
  WITH RECURSIVE closure(member_oid, role_oid, path_blocked) AS (
    SELECT m.member, m.roleid, NOT m.inherit_option
      FROM pg_auth_members m
    UNION
    SELECT c.member_oid, m.roleid, c.path_blocked OR NOT m.inherit_option
      FROM closure c JOIN pg_auth_members m ON m.member = c.role_oid
  )
  SELECT holder.rolname       AS role,
         holder.rolcanlogin   AS can_login,
         holder.rolsuper      AS is_super,
         holder.rolbypassrls  AS bypasses_rls,
         array_agg(DISTINCT held.rolname::text ORDER BY held.rolname::text) AS holds,
         bool_and(c.path_blocked) AS every_path_blocked,
         array_agg(DISTINCT held.rolname::text ORDER BY held.rolname::text)
           FILTER (WHERE NOT c.path_blocked) AS inherited
    FROM closure c
    JOIN pg_roles holder ON holder.oid = c.member_oid
    JOIN pg_roles held   ON held.oid   = c.role_oid
   WHERE held.rolname IN (${SUB_ROLE_LIST})
   GROUP BY 1, 2, 3, 4
   ORDER BY 1`;

/** Narrow a driver's array column without casting: anything that is not a string is dropped. */
function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.filter((item): item is string => typeof item === "string");
}

/**
 * Reads the CLUSTER's role graph. Not tenant-scoped and deliberately not wrapped in
 * `withTenant`: `pg_roles` / `pg_auth_members` are cluster catalogs, and this answers a question
 * about the deployment, not about a team. Takes `TkDb` so a plain handle and a transaction both
 * work — a `TkTx` is a `PgDatabase` too.
 */
export async function roleSeparationViolations(
  db: TkDb,
): Promise<readonly RoleSeparationViolation[]> {
  const rows = rowsOf(await db.execute(MEMBERSHIP_CLOSURE));
  const out: RoleSeparationViolation[] = [];
  for (const row of rows) {
    const role = String(row["role"]);
    const holds = toStringArray(row["holds"]);
    const inherited = toStringArray(row["inherited"]);

    // INV-2 first — a sub-role holding another sub-role leaks THROUGH a correct SET ROLE, so it
    // is reported no matter what the inherit option says.
    if (TESTKITE_SUB_ROLES.some((sub) => sub === role)) {
      out.push({
        kind: "sub_role_membership",
        role,
        holds,
        detail:
          `${role} is itself a member of ${holds.join(", ")}; permissive policies are OR-ed ` +
          `across the roles the current role belongs to, so a session that correctly SET ROLE ` +
          `to ${role} still reads other tenants. Fix: REVOKE ${holds.join(", ")} FROM ${role}. ` +
          `WITH INHERIT FALSE is NOT enough here — SET ROLE still reaches the union.`,
      });
      continue;
    }
    // An intermediate ops role is a path, not a holder: nothing runs as it, and the login on the
    // far end of the path is reported instead.
    if (row["can_login"] !== true) continue;

    // INV-3 before INV-1: a SUPERUSER/BYPASSRLS login makes the inherit question moot.
    if (row["is_super"] === true || row["bypasses_rls"] === true) {
      out.push({
        kind: "privileged_login",
        role,
        holds,
        detail:
          `${role} can log in with SUPERUSER or BYPASSRLS while holding ${holds.join(", ")}; ` +
          `RLS does not apply to it at all (spike 2026-08-27), so tenant isolation is off for ` +
          `every statement it runs. Fix: ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS, or run the ` +
          `deployment on a login that has neither.`,
      });
      continue;
    }
    // INV-1: at least one unblocked path exists, so the login carries those privileges without
    // ever running SET ROLE.
    if (row["every_path_blocked"] !== true) {
      out.push({
        kind: "inheriting_login",
        role,
        holds,
        detail:
          `${role} INHERITS ${inherited.join(", ")}; any statement that does not SET ROLE runs ` +
          `with the union of their privileges, and job_runs' two permissive policies OR into a ` +
          `cross-tenant read. Fix: REVOKE that membership and re-GRANT it WITH INHERIT FALSE ` +
          `(ALTER ROLE ${role} NOINHERIT alone does NOT touch grants that already exist — ` +
          `PostgreSQL 16+ stores inheritance per grant, measured 2026-08-31).`,
      });
    }
  }
  return out;
}
