-- The part drizzle-kit does NOT generate: GRANT (same pattern as 0026/0028/0030/0032).
--
-- The AUTH PATH has to read a run token BEFORE the tenant is known — the row is what ANSWERS
-- "which tenant?" — which is the exact deadlock api_tokens hit in M2 (migration 0016). SELECT
-- ONLY, through the auth_lookup policy: a role that could also UPDATE this table could revoke
-- a running job's credential while holding no tenant credential at all.
GRANT SELECT ON "orc_run_tokens" TO "testkite_auth";
--> statement-breakpoint
-- The request path mints, reads and revokes its own team's run tokens, fenced by
-- tenant_isolation. No DELETE: a revoked token must stay auditable until retention removes it.
GRANT SELECT, INSERT, UPDATE ON "orc_run_tokens" TO "testkite_app";
--> statement-breakpoint
-- The fleet roster is NOT tenant data, carries no team_id and therefore no RLS — so this GRANT
-- is the whole access control for it, and it holds the SHA-256 of every live worker credential.
-- Only the dispatch path touches it (register / verify / heartbeat). The request-path role gets
-- NOTHING, not even SELECT: a leaked app connection must not be able to enumerate the fleet.
GRANT SELECT, INSERT, UPDATE ON "orc_workers" TO "testkite_dispatch";
