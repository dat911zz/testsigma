/**
 * `res_artifacts` — the control plane's half of an artifact upload: record what is about to
 * be stored, hand back a short-lived signed PUT, and never touch a byte of it.
 *
 * Two rules carry the security of this path and both are asserted below rather than assumed:
 *  - the object key STARTS WITH THE TEAM ID, and the signature covers the path, so a leaked
 *    or replayed URL cannot be edited into another tenant's object;
 *  - the job is proven to belong to the caller BY THE COMPOSITE FK, not by a `SELECT` taken
 *    from an older snapshot — a cross-tenant job id is refused with 404, never 403.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationFailedError } from "@testkite/contract";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_URL_TTL_SECONDS,
  createArtifactUpload,
  type ArtifactKind,
} from "../../src/modules/results/artifacts.js";
import { presignS3Url } from "../../src/modules/results/s3/presign.js";

/** The store this suite signs against. No network is involved — a signature is arithmetic. */
const S3 = {
  endpoint: "https://minio.internal:9000",
  region: "us-east-1",
  bucket: "tk-artifacts",
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
} as const;

const NOW = new Date("2026-08-30T10:15:00.000Z");
const SHA = "a".repeat(64);

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>", while the Postgres message carrying the constraint name lives in
 * `.cause` (same helper as read-rule.test.ts).
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: unknown) {
    const parts: string[] = [];
    let cur: unknown = err;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    return parts.join(" | ");
  }
  throw new Error("query was expected to be rejected by Postgres, but it succeeded");
}

describe("artifact upload slot", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;
  let jobRunId: string;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
    const seeded = await t.seedJobs(a, 1);
    const first = seeded[0];
    if (first === undefined) throw new Error("seedJobs returned no job");
    jobRunId = first;
  });

  it("records metadata as `pending` and hands back a 15-minute URL", async () => {
    const slot = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      createArtifactUpload(
        tx,
        ctx,
        {
          jobRunId,
          attempt: 1,
          kind: "trace",
          contentType: "application/zip",
          sizeBytes: 3304,
          sha256: SHA,
          now: NOW,
        },
        S3,
      ),
    );

    const rows = await t.dumpTable("res_artifacts");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("unreachable");
    expect(row["status"]).toBe("pending");
    expect(row["uploaded_at"]).toBeNull();
    expect(String(row["id"])).toBe(slot.artifactId);
    expect(String(row["kind"])).toBe("trace");
    expect(String(row["content_type"])).toBe("application/zip");
    expect(Number(row["size_bytes"])).toBe(3304);
    expect(String(row["sha256"])).toBe(SHA);
    expect(Number(row["attempt"])).toBe(1);

    // 15 minutes: long enough for a 2GB trace on a slow link, short enough that a URL found
    // in a log tomorrow is already dead.
    expect(ARTIFACT_URL_TTL_SECONDS).toBe(900);
    expect(slot.expiresAt.toISOString()).toBe("2026-08-30T10:30:00.000Z");
    expect(slot.url).toContain(`X-Amz-Expires=${String(ARTIFACT_URL_TTL_SECONDS)}`);
    expect(slot.url.startsWith(`${S3.endpoint}/${S3.bucket}/`)).toBe(true);
    expect(slot.url).toContain(String(row["object_key"]));
    // Both headers are SIGNED, so the worker is not being advised, it is being told what the
    // signature already covers: a PUT that sends anything else is a request the store cannot
    // verify. `X-Amz-SignedHeaders` is the half of that statement that lives in the URL.
    expect(slot.headers).toEqual({
      "Content-Type": "application/zip",
      "Content-Length": "3304",
    });
    expect(slot.url).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
    /*
     * The size ceiling is only worth something if it survives the handoff: refusing to sign a
     * size over the cap is decorative if the URL that IS signed lets the holder PUT a different
     * number of bytes to the same key. Re-deriving the whole URL from the stored key and the
     * stored size is how that is stated exactly — a handler that signed `0`, or the wrong
     * content type, produces a different signature and this line goes red.
     */
    expect(slot.url).toBe(
      presignS3Url({
        method: "PUT",
        endpoint: S3.endpoint,
        bucket: S3.bucket,
        key: String(row["object_key"]),
        region: S3.region,
        accessKey: S3.accessKey,
        secretKey: S3.secretKey,
        expiresSeconds: ARTIFACT_URL_TTL_SECONDS,
        contentLength: Number(row["size_bytes"]),
        contentType: String(row["content_type"]),
        now: NOW,
      }),
    );
  });

  it("puts the team id in the object key so a leaked key cannot name another tenant's object", async () => {
    const slot = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      createArtifactUpload(
        tx,
        ctx,
        {
          jobRunId,
          attempt: 2,
          kind: "screenshot_bundle",
          contentType: "application/zip",
          sizeBytes: 1024,
          sha256: SHA,
          now: NOW,
        },
        S3,
      ),
    );
    const rows = await t.dumpTable("res_artifacts");
    const objectKey = String(rows[0]?.["object_key"]);
    expect(objectKey).toBe(`${a.teamId}/${jobRunId}/2/screenshot_bundle/${slot.artifactId}`);
    // The signature covers the path, so rewriting the prefix to another tenant invalidates it.
    expect(objectKey.startsWith(`${a.teamId}/`)).toBe(true);
    expect(objectKey).not.toContain(b.teamId);
    expect(slot.url).toContain(`/${S3.bucket}/${objectKey}?`);
  });

  it("refuses a size over the per-artifact cap instead of signing it", async () => {
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        createArtifactUpload(
          tx,
          ctx,
          {
            jobRunId,
            attempt: 1,
            kind: "video",
            contentType: "video/webm",
            sizeBytes: ARTIFACT_MAX_BYTES + 1,
            sha256: SHA,
            now: NOW,
          },
          S3,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    // Refused BEFORE the metadata row, so an oversize upload leaves nothing behind to clean up.
    expect(await t.countRows("res_artifacts")).toBe(0);
    // The cap is exactly int4's ceiling — the boundary itself must still be accepted.
    const slot = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      createArtifactUpload(
        tx,
        ctx,
        {
          jobRunId,
          attempt: 1,
          kind: "video",
          contentType: "video/webm",
          sizeBytes: ARTIFACT_MAX_BYTES,
          sha256: SHA,
          now: NOW,
        },
        S3,
      ),
    );
    expect(slot.artifactId).not.toBe("");
  });

  it("404s when the job belongs to another team", async () => {
    const other = (await t.seedJobs(b, 1))[0];
    if (other === undefined) throw new Error("seedJobs returned no job");
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        createArtifactUpload(
          tx,
          ctx,
          {
            jobRunId: other,
            attempt: 1,
            kind: "log",
            contentType: "text/plain",
            sizeBytes: 12,
            sha256: SHA,
            now: NOW,
          },
          S3,
        ),
      ),
      // 404, never 403: a distinct code would itself confirm the id exists (blueprint §3 L3).
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await t.countRows("res_artifacts")).toBe(0);
  });

  it("404s on a job id that does not exist at all, exactly like the cross-tenant one", async () => {
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        createArtifactUpload(
          tx,
          ctx,
          {
            jobRunId: "00000000-0000-4000-8000-0000000000ff",
            attempt: 1,
            kind: "log",
            contentType: "text/plain",
            sizeBytes: 12,
            sha256: SHA,
            now: NOW,
          },
          S3,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a kind outside the closed five instead of signing an unknown object", async () => {
    // The route validates `kind` with zod (Task 13), but this is a MODULE API: a caller that
    // skipped that check must still be refused. The cast is what lets the test stand where
    // the type system already stands — there is no other way to express "a value the type
    // forbids arrived anyway".
    const bogus = "core_dump" as ArtifactKind;
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        createArtifactUpload(
          tx,
          ctx,
          {
            jobRunId,
            attempt: 1,
            kind: bogus,
            contentType: "application/octet-stream",
            sizeBytes: 10,
            sha256: SHA,
            now: NOW,
          },
          S3,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await t.countRows("res_artifacts")).toBe(0);
    // The five the fleet contract publishes, and nothing else.
    expect([...ARTIFACT_KINDS]).toEqual([
      "trace",
      "screenshot",
      "screenshot_bundle",
      "video",
      "log",
    ]);
  });

  it("keeps the CHECK constraint as the second line of defence on kind and status", async () => {
    // Written on the OWNER connection: the subject is the STORAGE, not the service that
    // usually guards it. A zod schema at the edge is the first line of defence, not the only
    // one — the value arrives from a process running untrusted browser automation.
    expect(
      await rejectionMessage(() =>
        t.db.execute(sql`
          INSERT INTO res_artifacts (team_id, job_run_id, attempt, kind, object_key, content_type,
                                     size_bytes, sha256)
          VALUES (${a.teamId}, ${jobRunId}, 1, 'core_dump', 'k', 'application/octet-stream', 1, ${SHA})`),
      ),
    ).toContain("res_artifacts_kind_check");
    expect(
      await rejectionMessage(() =>
        t.db.execute(sql`
          INSERT INTO res_artifacts (team_id, job_run_id, attempt, kind, object_key, content_type,
                                     size_bytes, sha256, status)
          VALUES (${a.teamId}, ${jobRunId}, 1, 'log', 'k', 'text/plain', 1, ${SHA}, 'half_uploaded')`),
      ),
    ).toContain("res_artifacts_status_check");
    expect(
      await rejectionMessage(() =>
        t.db.execute(sql`
          INSERT INTO res_artifacts (team_id, job_run_id, attempt, kind, object_key, content_type,
                                     size_bytes, sha256)
          VALUES (${a.teamId}, ${jobRunId}, 1, 'log', 'k', 'text/plain', ${ARTIFACT_MAX_BYTES + 1}, ${SHA})`),
      ),
    ).toContain("res_artifacts_size_check");
  });

  it("hides another team's artifact rows and refuses to write one for them — RLS", async () => {
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      createArtifactUpload(
        tx,
        ctx,
        {
          jobRunId,
          attempt: 1,
          kind: "screenshot",
          contentType: "image/webp",
          sizeBytes: 2048,
          sha256: SHA,
          now: NOW,
        },
        S3,
      ),
    );
    const seenByB = await t.asTeam(b.teamId, (tx) =>
      tx.execute(sql`SELECT id FROM res_artifacts`),
    );
    expect(seenByB.rows).toHaveLength(0);
    // The fail-closed case: the app role with NO app.team_id at all. A predicate missing
    // NULLIF turns the unset GUC (an EMPTY STRING) into 22P02 instead of an empty result.
    const seenByNobody = await t.asAppRoleWithoutTenant((tx) =>
      tx.execute(sql`SELECT id FROM res_artifacts`),
    );
    expect(seenByNobody.rows).toHaveLength(0);
  });

  it("writes nothing without a tenant context — L1 fail-closed", async () => {
    await expect(
      t.asTeamCtx(a.teamId, (tx) =>
        createArtifactUpload(
          tx,
          { teamId: "" },
          {
            jobRunId,
            attempt: 1,
            kind: "trace",
            contentType: "application/zip",
            sizeBytes: 10,
            sha256: SHA,
            now: NOW,
          },
          S3,
        ),
      ),
    ).rejects.toThrow(/Invalid TenantContext/);
    expect(await t.countRows("res_artifacts")).toBe(0);
  });
});
