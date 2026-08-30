-- `run_ordinal`: the stable id the SSE stream puts in `id:` and resumes from.
--
-- WHY drizzle-kit's OUTPUT IS NOT ENOUGH HERE. It emits `ADD COLUMN "run_ordinal" bigint NOT
-- NULL`, which any database that already holds narration would refuse (0035 shipped the table
-- in this same milestone, so that is a dev database, but a migration that only replays on an
-- empty one is not a migration). The column is therefore added nullable, backfilled, and only
-- then pinned NOT NULL — and `orc_runs.event_ordinal`, the allocator, is moved up past what the
-- backfill handed out so the next event continues the sequence instead of colliding with it.
--
-- The backfill orders by `received_at` first: it is the closest thing an already-written row
-- has to an insertion order. (attempt, seq) is exactly the per-chain-local tuple this column
-- exists to replace, and is only a tiebreaker here.
ALTER TABLE "orc_runs" ADD COLUMN "event_ordinal" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orc_run_events" ADD COLUMN "run_ordinal" bigint;--> statement-breakpoint
WITH numbered AS (
  SELECT e.id,
         row_number() OVER (PARTITION BY e.team_id, j.run_id
                            ORDER BY e.received_at, e.attempt, e.seq, e.job_run_id) AS n
    FROM orc_run_events e
    JOIN job_runs j ON j.team_id = e.team_id AND j.id = e.job_run_id
)
UPDATE orc_run_events e SET run_ordinal = numbered.n
  FROM numbered WHERE numbered.id = e.id;--> statement-breakpoint
ALTER TABLE "orc_run_events" ALTER COLUMN "run_ordinal" SET NOT NULL;--> statement-breakpoint
UPDATE orc_runs r SET event_ordinal = allocated.high
  FROM (SELECT e.team_id, j.run_id, max(e.run_ordinal) AS high
          FROM orc_run_events e
          JOIN job_runs j ON j.team_id = e.team_id AND j.id = e.job_run_id
         GROUP BY e.team_id, j.run_id) allocated
 WHERE allocated.team_id = r.team_id AND allocated.run_id = r.id;
