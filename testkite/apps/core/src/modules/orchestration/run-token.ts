/**
 * ZERO-CREDENTIAL WORKER (blueprint §4, §5). A worker never holds a DB credential and never
 * holds a team API token. It holds exactly two things, both minted here:
 *   - a WORKER token, proving "I am worker w-1 on lane batch" — enough to heartbeat and claim;
 *   - a RUN token, naming exactly one (job_run, attempt, lease_epoch) and expiring with the lease.
 *
 * Neither is a tenant credential. A run token carries no scopes, no role and no user id: the
 * only thing it can address is the job it was minted for, through `/internal/fleet` (Task 13).
 * That is why it is safe to hand one to a process running untrusted browser automation.
 *
 * SHA-256 rather than argon2 — same reasoning as api_tokens (M2): 32 bytes of machine entropy
 * has nothing to brute force, and this is verified on every heartbeat (every 5s per running
 * chain), where argon2's 18ms would be the difference between "auth is free" and "auth is the
 * hot path".
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  assertTenantContext,
  firstRow,
  rowsOf,
  withAuthRole,
  withDispatchRole,
  type TenantContext,
  type TkDb,
  type TkTx,
} from "../kernel/index.js";

/** A run token outlives its lease by this much, so a heartbeat racing the deadline still authenticates. */
export const RUN_TOKEN_TTL_SLACK_SECONDS = 60;
/**
 * A worker token is renewed on every worker heartbeat (5s), so 24h is already generous: the TTL
 * measures SILENCE, not uptime. See `touchWorker` — the renewal is what makes that true.
 */
export const WORKER_TOKEN_TTL_HOURS = 24;

const PREFIX_BYTES = 4;
const SECRET_BYTES = 32;

/**
 * The KIND is part of the secret, not just of the row: a worker token presented to a job
 * endpoint is rejected by a regex, before any lookup could accidentally treat one kind of
 * credential as the other.
 */
const RUN_RE = /^tkr_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;
const WORKER_RE = /^tkw_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;

type WorkerLane = "interactive" | "batch";

function mintSecret(kind: "tkr" | "tkw"): {
  readonly secret: string;
  readonly prefix: string;
  readonly hash: Buffer;
} {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = `${kind}_${prefix}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, prefix, hash: createHash("sha256").update(secret).digest() };
}

/** Both drivers accept a hex literal for bytea; a raw Buffer parameter does not survive both. */
const byteaOf = (hash: Buffer): ReturnType<typeof sql> => sql`decode(${hash.toString("hex")}, 'hex')`;

const tsOf = (at: Date): ReturnType<typeof sql> => sql`${at.toISOString()}::timestamptz`;

/** One definition of "24h from this instant", shared by registration and every renewal. */
const workerTokenExpiryFrom = (now: Date): Date =>
  new Date(now.getTime() + WORKER_TOKEN_TTL_HOURS * 3_600_000);

const laneOf = (value: unknown): WorkerLane =>
  String(value) === "interactive" ? "interactive" : "batch";

export interface RunTokenScope {
  readonly tokenId: string;
  readonly teamId: string;
  readonly jobRunId: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
}

export interface WorkerTokenScope {
  readonly workerId: string;
  readonly lane: WorkerLane;
  readonly capacity: number;
}

/**
 * Registration ROTATES the credential: a worker that restarts (systemd Restart=always) gets a
 * fresh token and the previous one stops working the same instant. Leaving the old one alive
 * would mean the credential of a crashed container outlives the container — the one thing a
 * host-level compromise needs to keep claiming work.
 *
 * `drain` is deliberately NOT reset by re-registering, so a worker cannot un-drain itself by
 * bouncing its own process.
 */
export async function registerWorker(
  db: TkDb,
  input: {
    readonly workerId: string;
    readonly hostname: string;
    readonly lane: WorkerLane;
    readonly capacity: number;
    readonly now: Date;
  },
): Promise<{ readonly workerToken: string; readonly drain: boolean }> {
  const { secret, prefix, hash } = mintSecret("tkw");
  const expiresAt = workerTokenExpiryFrom(input.now);
  return withDispatchRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        INSERT INTO orc_workers (id, hostname, lane, capacity, prefix, token_hash, token_expires_at, last_seen_at)
        VALUES (${input.workerId}, ${input.hostname}, ${input.lane}, ${input.capacity},
                ${prefix}, ${byteaOf(hash)}, ${tsOf(expiresAt)}, ${tsOf(input.now)})
        ON CONFLICT (id) DO UPDATE SET
          hostname = EXCLUDED.hostname,
          lane = EXCLUDED.lane,
          capacity = EXCLUDED.capacity,
          prefix = EXCLUDED.prefix,
          token_hash = EXCLUDED.token_hash,
          token_expires_at = EXCLUDED.token_expires_at,
          last_seen_at = EXCLUDED.last_seen_at
        RETURNING drain`),
    );
    if (row === undefined) throw new Error("registerWorker: upsert returned no row");
    return { workerToken: secret, drain: row["drain"] === true };
  });
}

/**
 * Looks a worker token up by hash. Runs on the dispatch role: `orc_workers` is fleet
 * infrastructure with no tenant column and no RLS, so this role — and only this role — can
 * read it at all.
 */
export async function verifyWorkerToken(
  db: TkDb,
  secret: string,
  now: Date,
): Promise<WorkerTokenScope | null> {
  // Malformed, or the wrong KIND of token: answered without a round trip.
  if (!WORKER_RE.test(secret)) return null;
  const hash = createHash("sha256").update(secret).digest();
  return withDispatchRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        SELECT id, lane, capacity FROM orc_workers
         WHERE token_hash = ${byteaOf(hash)} AND token_expires_at > ${tsOf(now)}`),
    );
    if (row === undefined) return null;
    return {
      workerId: String(row["id"]),
      lane: laneOf(row["lane"]),
      capacity: Number(row["capacity"]),
    };
  });
}

/**
 * The worker heartbeat: records liveness and free slots, RENEWS the worker token, and answers
 * with the only command the host obeys.
 *
 * The renewal is not a nicety. `token_expires_at` is set once at registration, so without it the
 * 24h TTL would measure "time since this worker last restarted" — a worker beating every 5s for
 * a day would have `verifyWorkerToken` start returning null the instant that fixed deadline
 * passed, i.e. a demonstrably live machine would read as unauthenticated and stop being able to
 * claim or report. Renewing here makes the TTL measure SILENCE instead, which is what the fleet
 * contract promises ("TTL 24h, renewed at every worker heartbeat") and the only reading under
 * which 24h is a safe number: a worker that stops beating still loses its credential 24h later.
 *
 * Renewal happens for a DRAINING worker too — it still holds jobs it must finish and report on,
 * and "take no new work" is not "lose the credential you are using right now".
 *
 * DELIBERATE DEVIATION from the plan's block, which answered `continue` when no row matched: a
 * worker whose roster row is gone is told to DRAIN. "Carry on" is the one answer that must not
 * be given to a machine the control plane no longer knows about — and since the endpoint
 * verifies the worker token against this same table first, reaching zero rows here means the
 * worker was deregistered mid-flight, not that the input was odd. Zero rows also means nothing
 * was renewed, which is what `workerTokenRenewedAt: null` reports: the UPDATE never inserts, so
 * a heartbeat can neither resurrect a deregistered worker nor claim a renewal that did not
 * happen.
 */
export async function touchWorker(
  db: TkDb,
  input: { readonly workerId: string; readonly freeSlots: number; readonly now: Date },
): Promise<{
  readonly command: "continue" | "drain";
  /** When the token was renewed, or null if there was no roster row to renew. */
  readonly workerTokenRenewedAt: Date | null;
}> {
  const renewedUntil = workerTokenExpiryFrom(input.now);
  return withDispatchRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        UPDATE orc_workers
           SET last_seen_at = ${tsOf(input.now)},
               free_slots = ${input.freeSlots},
               token_expires_at = ${tsOf(renewedUntil)}
         WHERE id = ${input.workerId}
        RETURNING drain`),
    );
    if (row === undefined) return { command: "drain", workerTokenRenewedAt: null };
    return {
      command: row["drain"] === true ? "drain" : "continue",
      workerTokenRenewedAt: input.now,
    };
  });
}

/**
 * Minted inside the SAME transaction as the claim (Task 13), so a token can never exist for a
 * job the worker did not actually win. The composite FK (team_id, job_run_id) makes a token for
 * another team's job unrepresentable rather than merely unchecked.
 */
export async function mintRunToken(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly attempt: number;
    readonly leaseEpoch: number;
    readonly workerId: string;
    readonly expiresAt: Date;
  },
): Promise<{ readonly secret: string; readonly tokenId: string }> {
  const teamId = assertTenantContext(ctx);
  const { secret, prefix, hash } = mintSecret("tkr");
  const row = firstRow(
    await tx.execute(sql`
      INSERT INTO orc_run_tokens
        (team_id, job_run_id, attempt, lease_epoch, worker_id, prefix, token_hash, expires_at)
      VALUES (${teamId}, ${input.jobRunId}, ${input.attempt}, ${input.leaseEpoch},
              ${input.workerId}, ${prefix}, ${byteaOf(hash)}, ${tsOf(input.expiresAt)})
      RETURNING id`),
  );
  if (row === undefined) throw new Error("mintRunToken: INSERT returned no row");
  return { secret, tokenId: String(row["id"]) };
}

/**
 * Verification runs on the AUTH PATH: the tenant is unknown until the row is found — the same
 * fail-closed deadlock api_tokens hit in M2, solved the same way (`withAuthRole` plus an
 * `auth_lookup` policy). This function RETURNS the tenant; it never takes one.
 *
 * The returned scope is the WHOLE authority of the credential. Adding a field here — a role, a
 * scope list, a user id — would turn a job-shaped token into a tenant-shaped one; the "carries
 * no team scopes at all" test in run-token.test.ts is the tripwire for that.
 */
export async function verifyRunToken(
  db: TkDb,
  secret: string,
  now: Date,
): Promise<RunTokenScope | null> {
  // Malformed, or the wrong KIND of token: answered without a round trip.
  if (!RUN_RE.test(secret)) return null;
  const hash = createHash("sha256").update(secret).digest();
  return withAuthRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        SELECT id, team_id, job_run_id, attempt, lease_epoch FROM orc_run_tokens
         WHERE token_hash = ${byteaOf(hash)}
           AND revoked_at IS NULL AND expires_at > ${tsOf(now)}`),
    );
    if (row === undefined) return null;
    return {
      tokenId: String(row["id"]),
      teamId: String(row["team_id"]),
      jobRunId: String(row["job_run_id"]),
      attempt: Number(row["attempt"]),
      leaseEpoch: Number(row["lease_epoch"]),
    };
  });
}

/**
 * Pushes a live run token's expiry out to the lease deadline the heartbeat just wrote, plus the
 * same slack the claim used. Called in the SAME transaction as `heartbeatJob`, from the job
 * heartbeat handler, and nowhere else.
 *
 * It is not a nicety, for exactly the reason `touchWorker` renews the worker token: `expires_at`
 * is stamped once at claim time as `lease_expires_at + 60s`, i.e. 90 seconds after the claim,
 * while the lease itself is renewed by every heartbeat and a chain's budget reaches 900s.
 * Without this, a worker that is still the rightful owner of a running job — beating every 5s,
 * holding a real browser context — loses its credential a minute and a half in, and every call
 * from there is a 401 that tells it to exit and re-register over a job running perfectly.
 *
 * The fence is `lease_epoch`, not just the job id: a worker that was reaped mid-flight carries
 * an older epoch, so its heartbeat matches zero rows in `job_runs` and can therefore never reach
 * here — and if it somehow did, this UPDATE would match nothing either. `revoked_at IS NULL`
 * keeps a revoked token dead: renewal extends a live credential, it never resurrects one.
 *
 * Returns how many tokens were renewed, so a caller (or a test) can tell "renewed" from
 * "matched nothing" instead of assuming.
 */
export async function renewRunTokenTtl(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly leaseEpoch: number;
    readonly leaseExpiresAt: Date;
  },
): Promise<number> {
  const teamId = assertTenantContext(ctx);
  const expiresAt = new Date(
    input.leaseExpiresAt.getTime() + RUN_TOKEN_TTL_SLACK_SECONDS * 1000,
  );
  const renewed = rowsOf(
    await tx.execute(sql`
      UPDATE orc_run_tokens SET expires_at = ${tsOf(expiresAt)}
       WHERE team_id = ${teamId} AND job_run_id = ${input.jobRunId}
         AND lease_epoch = ${input.leaseEpoch} AND revoked_at IS NULL
      RETURNING id`),
  );
  return renewed.length;
}

/**
 * The ONE production call site is the infra-requeue branch of `internalComplete`: ownership has
 * just moved to the next attempt, so the credential minted for the old one dies with the lease
 * it named. Belt and braces alongside the epoch fence, and the cheaper of the two for the
 * worker, which then gets a 401 on its next call instead of discovering the loss on a mutation.
 *
 * Deliberately NOT called on the terminal path (a `complete` is delivered at least once, and a
 * retry must read 410 JOB_TERMINAL rather than 401) and NOT called by the reaper, which runs on
 * the dispatch role with no tenant in hand: a reaped job's token is fenced by its epoch and
 * lapses on its own TTL, since the heartbeat that would have renewed it stops matching rows.
 * `revokeRunTokensFor call sites` in run-token-ttl.test.ts is the tripwire for this sentence.
 *
 * Tenant-scoped like every other request-path write, so revoking is something only the owning
 * team's context can do; another team's call matches zero rows and says nothing about whether
 * the job exists.
 */
export async function revokeRunTokensFor(
  tx: TkTx,
  ctx: TenantContext,
  jobRunId: string,
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  await tx.execute(sql`
    UPDATE orc_run_tokens SET revoked_at = now()
     WHERE team_id = ${teamId} AND job_run_id = ${jobRunId} AND revoked_at IS NULL`);
}
