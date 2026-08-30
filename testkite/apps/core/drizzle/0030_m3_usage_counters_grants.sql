-- The part drizzle-kit does NOT generate: GRANT. RLS only filters rows AFTER the role has
-- table privileges; without the GRANT the app role gets "permission denied", which is not
-- fail-closed (same pattern as 0023/0026/0028).
--
-- No DELETE: a counter is reserved, refunded and then aged out by retention (M5) — the
-- request path must never be able to wipe a day's usage to buy itself more quota.
-- The dispatch role is deliberately absent: quota is decided on the REQUEST path, before
-- anything is queued, so the claim path has no business reading or writing counters.
GRANT SELECT, INSERT, UPDATE ON usage_counters TO "testkite_app";
