/**
 * The control plane's half of an artifact upload: record what is about to be stored, hand back
 * a short-lived signed PUT, and never touch a byte. No artifact travels through the API
 * process — the worker PUTs straight at the object store (blueprint §5). Ring-buffer on NVMe,
 * retain-on-failure for traces and the upload itself are the fleet plan's job, not this one.
 *
 * The job is proven to belong to the caller BY THE COMPOSITE FK, not by a `SELECT` first. That
 * is not a shortcut, it is the point: a predicate is evaluated against the snapshot the
 * statement started with, so a job deleted (or a team rewritten) by a transaction that commits
 * in between is invisible to it — the shape that published outbox events twice until
 * 2026-08-30 (kernel/outbox relay, commit c0c2f42). The engine checks a foreign key at WRITE
 * time, against the committed row, and a cross-tenant job id is then refused by construction.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { NotFoundError, ValidationFailedError } from "@testkite/contract";
import { assertTenantContext, rowsOf, type TenantContext, type TkTx } from "../kernel/index.js";
import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  type ArtifactKind,
} from "./db/artifact-schema.js";
import { presignS3Url } from "./s3/presign.js";

// Re-exported from the schema module, where the CHECK constraints on `res_artifacts` are built
// from these same values — the type and the columns can therefore never disagree.
export { ARTIFACT_KINDS, ARTIFACT_MAX_BYTES, type ArtifactKind };

/** 15 minutes — long enough for a 2GB trace on a slow link, short enough that a URL found in a
 * log tomorrow is already dead. */
export const ARTIFACT_URL_TTL_SECONDS = 900;

/** Where the blobs go. Built from `KernelEnv` at the composition root, never read here. */
export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface CreateArtifactUploadInput {
  readonly jobRunId: string;
  readonly attempt: number;
  readonly kind: ArtifactKind;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /**
   * Signs the URL and stamps its expiry — injected so a signature is reproducible in a test.
   * It is deliberately NOT what lands in `created_at`: a stored fact takes the DATABASE's
   * clock, so a caller cannot backdate the record of an upload it asked for.
   */
  readonly now: Date;
}

export interface ArtifactUploadSlot {
  readonly artifactId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: Date;
}

/**
 * The object key STARTS WITH THE TEAM ID. Two reasons, both load-bearing:
 *   1. a leaked or replayed URL still cannot name another tenant's object — the signature
 *      covers the path, so changing the prefix invalidates it;
 *   2. lifecycle rules and per-team retention (artifact_retention_days) are prefix rules.
 */
function objectKey(
  teamId: string,
  jobRunId: string,
  attempt: number,
  artifactId: string,
  kind: string,
): string {
  return `${teamId}/${jobRunId}/${String(attempt)}/${kind}/${artifactId}`;
}

/** Anything with properties — enough to read the `code`/`constraint`/`cause` a driver error carries. */
function isErrorLike(
  value: unknown,
): value is { readonly code?: unknown; readonly constraint?: unknown; readonly cause?: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * True when a Postgres foreign-key violation (23503) on `constraint` is anywhere in the cause
 * chain. drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`, whose `.message` is
 * only "Failed query: <sql>" — the code and the constraint name live on `.cause`. Both drivers
 * in use expose them identically (verified 2026-08-30 on PGlite 0.5 and node-postgres 8).
 * The depth bound is there so a self-referencing `cause` cannot hang the request.
 */
function violatesForeignKey(err: unknown, constraint: string): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && isErrorLike(cur); depth += 1) {
    if (cur.code === "23503" && cur.constraint === constraint) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Reserves one upload slot: a `pending` metadata row plus a signed PUT that expires in 15
 * minutes. It does NOT wait for the bytes — `status` moves to `uploaded` only when the worker
 * reports them (Task 13), so a row still `pending` an hour later is the record of a failed
 * upload rather than a hole in the evidence.
 *
 * `kind` and `sizeBytes` are re-checked here even though the route validates them with zod
 * (Task 13). This is a MODULE API and the values arrive from a process running untrusted
 * browser automation: the edge schema is the first line of defence, the CHECK constraints on
 * the table are the last, and this is the one that refuses to SIGN.
 *
 * The refusal has teeth because the size is IN the signature: the PUT is signed over
 * `content-length;content-type;host`, so the URL handed back names one number of bytes and one
 * media type, and a request carrying different ones is not the request that was signed. Without
 * that binding the ceiling would only ever have been a suggestion — the same URL would accept
 * any body at all. (What a given store DOES with an unsigned mismatch is its own affair; the
 * statement made here is about the signature, and end-to-end behaviour is host-pilot evidence.)
 */
export async function createArtifactUpload(
  tx: TkTx,
  ctx: TenantContext,
  input: CreateArtifactUploadInput,
  deps: S3Config,
): Promise<ArtifactUploadSlot> {
  const teamId = assertTenantContext(ctx);
  if (!ARTIFACT_KINDS.includes(input.kind)) {
    throw new ValidationFailedError("Unknown artifact kind.", [
      `kind: must be one of ${ARTIFACT_KINDS.join(", ")}`,
    ]);
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new ValidationFailedError("Artifact size is not a byte count.", [
      "sizeBytes: must be a non-negative integer",
    ]);
  }
  if (input.sizeBytes > ARTIFACT_MAX_BYTES) {
    throw new ValidationFailedError("Artifact is larger than the per-artifact limit.", [
      `sizeBytes: must be at most ${String(ARTIFACT_MAX_BYTES)}`,
    ]);
  }

  // The id is minted HERE rather than by the column default: the object key contains it, and
  // reading it back from the INSERT would mean either signing after a second round trip or
  // writing the key with an UPDATE that the store never sees.
  const artifactId = randomUUID();
  const key = objectKey(teamId, input.jobRunId, input.attempt, artifactId, input.kind);
  try {
    const inserted = rowsOf(await tx.execute(sql`
      INSERT INTO res_artifacts (team_id, id, job_run_id, attempt, kind, object_key, content_type,
                                 size_bytes, sha256, status)
      VALUES (${teamId}, ${artifactId}, ${input.jobRunId}, ${input.attempt}, ${input.kind}, ${key},
              ${input.contentType}, ${input.sizeBytes}, ${input.sha256}, 'pending')
      RETURNING id`));
    if (inserted.length === 0) {
      // RLS refuses a cross-tenant write with an error rather than 0 rows, so an empty
      // RETURNING here means the statement itself changed shape — never "not allowed".
      throw new Error("res_artifacts: INSERT ... RETURNING produced no row");
    }
  } catch (err: unknown) {
    // A job that does not exist and a job belonging to another team are the SAME answer:
    // a distinct code would itself confirm the id exists (blueprint §3 L3 — never 403).
    if (violatesForeignKey(err, "res_artifacts_job_fk")) {
      throw new NotFoundError(`Job run not found: ${input.jobRunId}`);
    }
    throw err;
  }

  return {
    artifactId,
    url: presignS3Url({
      method: "PUT",
      endpoint: deps.endpoint,
      bucket: deps.bucket,
      key,
      region: deps.region,
      accessKey: deps.accessKey,
      secretKey: deps.secretKey,
      expiresSeconds: ARTIFACT_URL_TTL_SECONDS,
      // Signed, not merely recorded: the size the metadata row claims is the size the URL is
      // good for, and the content type the results page will render is the one it is good for.
      contentLength: input.sizeBytes,
      contentType: input.contentType,
      now: input.now,
    }),
    // Exactly the headers the signature covers, spelled the way the wire spells them. The worker
    // is not being advised here — sending anything else produces a request the store cannot
    // verify against the signature it was given.
    headers: {
      "Content-Type": input.contentType,
      "Content-Length": String(input.sizeBytes),
    },
    expiresAt: new Date(input.now.getTime() + ARTIFACT_URL_TTL_SECONDS * 1_000),
  };
}

/**
 * The other half of an upload's lifecycle: the worker reported, at `complete` time, which blobs
 * actually landed. Matching is BY DIGEST — the worker knows the sha256 of what it wrote, and it
 * would have to have read the response of every presign call back to be able to quote artifact
 * ids instead. A digest it never got a slot for matches nothing and is silently ignored: an
 * upload the control plane never signed cannot exist in the store.
 *
 * Scoped to `(team_id, job_run_id, attempt)` and to rows still `pending`, so a replayed
 * `complete` is a no-op rather than a second `uploaded_at`, and an earlier attempt's artifacts
 * keep their own history. `uploaded_at` takes the DATABASE clock for the same reason
 * `created_at` does: a caller must not be able to backdate a stored fact.
 *
 * Returns how many rows moved, which is what lets a caller notice a worker claiming blobs it
 * never asked to store.
 */
export async function markArtifactsUploaded(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly attempt: number;
    readonly sha256s: readonly string[];
  },
): Promise<number> {
  const teamId = assertTenantContext(ctx);
  if (input.sha256s.length === 0) return 0;
  const digests = sql.join(
    input.sha256s.map((digest) => sql`${digest}`),
    sql`, `,
  );
  const updated = rowsOf(await tx.execute(sql`
    UPDATE res_artifacts SET status = 'uploaded', uploaded_at = now()
     WHERE team_id = ${teamId} AND job_run_id = ${input.jobRunId} AND attempt = ${input.attempt}
       AND status = 'pending' AND sha256 IN (${digests})
    RETURNING id`));
  return updated.length;
}
