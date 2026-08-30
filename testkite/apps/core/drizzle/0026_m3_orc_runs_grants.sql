-- The part drizzle-kit does NOT generate: GRANT. RLS only filters rows AFTER the role has
-- table privileges; without the GRANT the app role gets "permission denied", which is not fail-closed.
GRANT SELECT, INSERT, UPDATE ON orc_runs TO "testkite_app";
--> statement-breakpoint
-- APPEND-ONLY: a frozen plan is what the worker executes and what the content hash names.
-- No UPDATE, no DELETE — the DB refuses, we do not merely avoid calling it.
GRANT SELECT, INSERT ON orc_run_plans TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON orc_compile_diagnostics TO "testkite_app";
