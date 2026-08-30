-- The part drizzle-kit does NOT generate: GRANT (same pattern as 0026/0028/0030/0032/0034).
--
-- APPEND-ONLY AT THE PRIVILEGE LAYER. A run event is EVIDENCE: it is what the SSE stream
-- replayed to the user, what the incident timeline is reconstructed from, and the only record
-- of what a worker claimed to be doing before it died. So the request path — the very path a
-- worker's `/internal/fleet` call runs through — gets SELECT and INSERT and nothing else.
-- Idempotency needs no UPDATE (ON CONFLICT DO NOTHING), and retention is a partition/DELETE
-- job for a role that does not serve requests, so neither privilege has a caller here.
GRANT SELECT, INSERT ON "orc_run_events" TO "testkite_app";
