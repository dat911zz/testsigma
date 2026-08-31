-- Wires real login roles into TestKite's four database roles, and checks the three separation
-- invariants. Run ONCE per cluster, as a superuser, BEFORE the first deploy:
--
--   psql "$ADMIN_URL" -v app_login=testkite_prod -v relay_login=testkite_relay_prod \
--        -f scripts/grant-db-roles.sql
--
-- Re-check at any time, changing nothing:
--
--   psql "$ADMIN_URL" -v check_only=1 -f scripts/grant-db-roles.sql
--
-- Exit status is the answer: the script raises on the first violation, so `set -e` around it is
-- a gate, not a suggestion. Run it after EVERY change ops makes to roles.
--
-- The FOUR roles are created by migrations (0001 / 0005 / 0015 / 0027): testkite_app,
-- testkite_relay, testkite_auth, testkite_dispatch. None of them can log in. This file connects
-- a real login to them, and that connection is the whole security boundary.
--
-- INHERITANCE IS THE BOUNDARY, MEMBERSHIP IS NOT. apps/core opens ONE pool and SET LOCAL ROLEs
-- to app / auth / dispatch (apps/core/src/modules/kernel/db/tenant.ts), so its login MUST be a
-- member of all three or SET ROLE fails outright. What must never happen is the login INHERITING
-- them: measured 2026-08-31, a login that inherits testkite_app and testkite_dispatch read
-- job_runs for EVERY team even with app.team_id set correctly, because job_runs carries two
-- PERMISSIVE policies (tenant_isolation TO app, dispatch_all TO dispatch USING true) and
-- permissive policies are OR-ed. The same login granted WITH INHERIT FALSE gets
-- "permission denied for table" on a statement that forgot to SET ROLE, while all three SET ROLE
-- paths keep working exactly as designed (measured the same day).
-- Same shape, at least as dangerous: auth_lookup is PERMISSIVE FOR SELECT USING (true) on
-- api_tokens / memberships / idn_oidc_connectors / idn_oidc_login_states / orc_run_tokens.
--
-- WITH INHERIT FALSE ON THE GRANT, NOT JUST NOINHERIT ON THE ROLE. PostgreSQL 16 moved
-- inheritance onto the grant (pg_auth_members.inherit_option); the role attribute is only the
-- default for grants made afterwards. Measured 2026-08-31: a login granted while INHERIT and
-- then switched with ALTER ROLE ... NOINHERIT reports rolinherit = false AND STILL READS EVERY
-- TEAM. Both are written below so neither one alone is load-bearing.

\set ON_ERROR_STOP on

\if :{?check_only}
\else
\if :{?app_login}
\else
\echo 'FATAL: pass -v app_login=<role> -v relay_login=<role>, or -v check_only=1 to only check.'
\quit
\endif
\if :{?relay_login}
\else
\echo 'FATAL: pass -v relay_login=<role> too. The relay is a DIFFERENT PROCESS and must not'
\echo '       share the API login: a union of privileges is what this file exists to prevent.'
\quit
\endif

-- 1) The API process's login. Member of app + auth + dispatch, inheriting none of them.
--    No password here on purpose: credentials come from infrastructure (a secret manager, or
--    cloud IAM auth), never from a file in this repository.
CREATE ROLE :"app_login" LOGIN NOINHERIT;
GRANT "testkite_app", "testkite_auth", "testkite_dispatch" TO :"app_login" WITH INHERIT FALSE;

-- 2) The outbox relay's login — A DIFFERENT PROCESS, A DIFFERENT LOGIN. Do not fold it into
--    app_login.
--    WARNING (checked 2026-08-31): apps/core/src/modules/kernel/outbox/relay.ts calls
--    `db.execute` DIRECTLY with no SET ROLE, and is not wired into composition-root yet. Under a
--    non-inheriting login it will fail closed the day it is wired, which is the DESIRED outcome:
--    either give it a `withRelayRole` wrapper like the other three paths, or let the relay login
--    SET ROLE for itself. Fix it when the relay lands (M6); never paper over it by re-granting
--    with inheritance.
CREATE ROLE :"relay_login" LOGIN NOINHERIT;
GRANT "testkite_relay" TO :"relay_login" WITH INHERIT FALSE;

-- 3) The schema owner / migration role is NEITHER of the two above. It needs DDL; they do not.
--    Name it and grant it with the infrastructure tooling, outside this file.
\endif


-- ---------------------------------------------------------------------------------------------
-- Checks — the same three invariants apps/core/test/schema/role-separation.test.ts asserts, and
-- the same recursive closure apps/core/src/modules/kernel/db/role-separation.ts runs. A
-- DIRECT-EDGE query is not enough: a two-hop grant (login -> some_ops_role -> testkite_dispatch)
-- is invisible to it, and that is the violation ops produces most often.
--
-- A path carries privileges only when EVERY edge on it inherits, so `path_blocked` accumulates
-- with OR and a role is safe only when bool_and(path_blocked) holds over every path to it.
-- Membership is counted regardless of inherit_option, because GRANT ... WITH INHERIT FALSE still
-- allows SET ROLE — which is why INV-2 does not look at the option at all.
-- ---------------------------------------------------------------------------------------------

CREATE TEMP VIEW tk_role_closure AS
WITH RECURSIVE closure(member_oid, role_oid, path_blocked) AS (
  SELECT m.member, m.roleid, NOT m.inherit_option
    FROM pg_auth_members m
  UNION
  SELECT c.member_oid, m.roleid, c.path_blocked OR NOT m.inherit_option
    FROM closure c JOIN pg_auth_members m ON m.member = c.role_oid
)
SELECT holder.rolname::text AS role,
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
 WHERE held.rolname IN ('testkite_app', 'testkite_auth', 'testkite_relay', 'testkite_dispatch')
 GROUP BY 1, 2, 3, 4;

\echo ''
\echo '=== INV-1: a login that INHERITS a testkite_* role (must be EMPTY) ==='
\echo '    Fix: REVOKE the membership, then GRANT it again WITH INHERIT FALSE.'
SELECT role, inherited
  FROM tk_role_closure
 WHERE can_login AND NOT is_super AND NOT bypasses_rls AND NOT every_path_blocked
 ORDER BY role;

\echo ''
\echo '=== INV-2: a testkite_* role that is a member of another one (must be EMPTY) ==='
\echo '    Fix: REVOKE it. WITH INHERIT FALSE is NOT enough — SET ROLE still reaches the union.'
SELECT role, holds
  FROM tk_role_closure
 WHERE role IN ('testkite_app', 'testkite_auth', 'testkite_relay', 'testkite_dispatch')
 ORDER BY role;

\echo ''
\echo '=== INV-3: a login holding a testkite_* role while SUPERUSER/BYPASSRLS (must be EMPTY) ==='
\echo '    Fix: ALTER ROLE <role> NOSUPERUSER NOBYPASSRLS. RLS does not apply to it at all.'
SELECT role, holds, is_super, bypasses_rls
  FROM tk_role_closure
 WHERE can_login AND (is_super OR bypasses_rls)
 ORDER BY role;

\echo ''
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tk_role_closure
   WHERE (can_login AND NOT is_super AND NOT bypasses_rls AND NOT every_path_blocked)
      OR (role IN ('testkite_app', 'testkite_auth', 'testkite_relay', 'testkite_dispatch'))
      OR (can_login AND (is_super OR bypasses_rls));
  IF n > 0 THEN
    RAISE EXCEPTION 'DB role separation: % violation(s) listed above; see testkite/docs/runbook-db-roles.md', n;
  END IF;
  RAISE NOTICE 'DB role separation: all three invariants hold on this cluster.';
END $$;

DROP VIEW tk_role_closure;
