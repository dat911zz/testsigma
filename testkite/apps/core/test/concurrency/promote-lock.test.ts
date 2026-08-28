/**
 * PROOF that "advisory lock (team, case) works" — runs ONLY on REAL Postgres.
 *
 * WHY A SEPARATE FILE IS NEEDED: the promote test at the PGlite layer (test/authoring/promote.test.ts)
 * proves "the lock IS ACQUIRED" (checking `pg_locks`), but does NOT prove
 * "the lock HAS AN EFFECT": PGlite has only ONE wasm connection, so two "parallel" `withTenant`
 * calls there queue sequentially — the lock is never contended, and the test passes even with the lock removed.
 * Real contention requires two real connections, i.e. real Postgres.
 *
 * Four claims are measured here:
 *  1. two parallel `promoteCase` calls with the same `expectedVersion` ⇒ EXACTLY ONE wins, the loser
 *     fails in a CONTROLLED way (contractual 409, not an infrastructure error);
 *  2. the DB after the race matches the winner — exactly one `ready` row, version bumped EXACTLY ONCE,
 *     `ready_revision_id` is pinned (no promote overwrites it haphazardly);
 *  3. the lock ACTUALLY blocks: holding the lock on connection A makes connection B wait;
 *  4. the lock is per (team, case), not global: a different case ⇒ they don't block each other.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the whole suite skips (`eval "$(scripts/test-pg.sh start)"` to
 * spin up a temporary cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 *
 * DELIBERATE DEVIATION FROM THE BLOCK IN THE PLAN — added a blocking gate `makeGate(2)` (exactly like
 * review-state-race.test.ts) to the first two tests. MEASURED FOR REAL on PostgreSQL 16.13, after removing
 * `cases.lockCase(...)` from `loadForMutation`:
 *   - the plan's block VERBATIM: `Test Files 1 passed | Tests 4 passed` — PASSES even
 *     WITHOUT the lock, meaning it proves nothing at all. Root cause: `Promise.all` starts
 *     two `withTenant` calls, but the second one must open a BRAND NEW PHYSICAL connection (cold
 *     pool, TCP + auth), so it reads `version` AFTER the first one has already COMMITted — the two
 *     transactions never overlap in the check-then-act window. Exactly the kind of "false green"
 *     this task exists to kill;
 *   - with the gate: both transactions have finished BEGIN + `SET LOCAL ROLE` + `set_config`
 *     before either can read ⇒ removing the lock goes RED immediately (`expected 2 to be 1`, both
 *     promotes return version 5 — a silent lost update).
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  promoteCase,
  submitForReview,
} from "../../src/modules/authoring/review-service.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** A blocking gate: opens once `n` parties have arrived. Forces both transactions to OPEN before either reads. */
function makeGate(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

/**
 * Deliberate deviation from the block in the plan: the plan wrote
 * `expect((loser as { httpStatus?: number }).httpStatus).toBe(409)`.
 * Casting from `unknown` to a shape is what TestKite's code standard bans, and it's even WEAKER:
 * if `loser` is `undefined` (both sides won — exactly the bug this task hunts for), the
 * cast throws a TypeError, and the test goes red for the wrong reason. The function below returns `undefined`
 * for anything that isn't an error with `httpStatus`, so the `toBe(409)` assertion correctly catches both kinds of failure.
 */
function httpStatusOf(value: unknown): number | undefined {
  if (!(value instanceof Error)) return undefined;
  const status: unknown = (value as { readonly httpStatus?: unknown }).httpStatus;
  return typeof status === "number" ? status : undefined;
}

describeRealPg("promote under real contention (real Postgres, two connections)", () => {
  let r: RealDb;
  let teamId = "";
  let projectId = "";
  const alice = { userId: "" };
  const bob = { userId: "" };
  const carol = { userId: "" };

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE aut_case_reviews, aut_case_revisions, aut_rest_steps, aut_step_loops, aut_steps,
               aut_cases, memberships, projects, teams, users, organizations RESTART IDENTITY CASCADE`);
    const org = await r.db.execute(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const orgId = String(org.rows[0]?.["id"]);
    const team = await r.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
    );
    teamId = String(team.rows[0]?.["id"]);
    const p = await r.db.execute(
      sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
    );
    projectId = String(p.rows[0]?.["id"]);
    for (const [email, name, holder] of [
      ["a@x.test", "Alice", alice],
      ["b@x.test", "Bob", bob],
      ["c@x.test", "Carol", carol],
    ] as const) {
      const u = await r.db.execute(
        sql`INSERT INTO users (email, display_name) VALUES (${email},${name}) RETURNING id`,
      );
      holder.userId = String(u.rows[0]?.["id"]);
    }
  });

  const ctx = (): { teamId: string } => ({ teamId });

  /**
   * A case that's been approved and is READY to promote. Alice is the last-editor, Bob is the approver
   * ⇒ both Bob and Carol pass the four-eyes gate (a 403 four-eyes must not be allowed to
   * muddy the evidence about the lock).
   */
  async function approvedCase(): Promise<{ id: string; version: number }> {
    const created = await withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    const edited = await withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: created.id,
        expectedVersion: created.version,
        steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
      }),
    );
    const submitted = await withTenant(r.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: edited.id, expectedVersion: edited.version }),
    );
    const decided = await withTenant(r.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: edited.id,
        expectedVersion: submitted.version,
        decision: "approved",
      }),
    );
    return { id: decided.id, version: decided.version };
  }

  it("two parallel promotes: EXACTLY ONE wins, the other fails in a controlled way", async () => {
    const c = await approvedCase();
    const gate = makeGate(2);
    const attempt = (): Promise<unknown> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version });
      })
        .then(() => "ok" as const)
        .catch((e: unknown) => e);

    const [x, y] = await Promise.all([attempt(), attempt()]);
    const okCount = [x, y].filter((v) => v === "ok").length;
    expect(okCount).toBe(1);

    // The loser must NOT be an infrastructure error — it must be 409 (version was already bumped by the winner).
    const loser = [x, y].find((v) => v !== "ok");
    expect(httpStatusOf(loser)).toBe(409);
  });

  it("sequential promotes don't scramble ready_revision_id — exactly 1 ready row", async () => {
    const c = await approvedCase();
    const gate = makeGate(2);
    await Promise.all([
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version });
      }).catch(() => undefined),
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), carol, { caseId: c.id, expectedVersion: c.version });
      }).catch(() => undefined),
    ]);
    const res = await r.db.execute(sql`
      SELECT status, version, ready_revision_id, promoted_by FROM aut_cases WHERE id = ${c.id}`);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.["status"]).toBe("ready");
    expect(Number(res.rows[0]?.["version"])).toBe(c.version + 1);
    expect(res.rows[0]?.["ready_revision_id"]).not.toBeNull();
  });

  it("the advisory lock ACTUALLY blocks: holding the lock on connection A makes connection B wait", async () => {
    const c = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        c.id,
      ]);

      let bAcquired = false;
      const bPromise = (async () => {
        await b.query("BEGIN");
        await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
          teamId,
          c.id,
        ]);
        bAcquired = true;
        await b.query("COMMIT");
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      // Proof of real lock contention — something PGlite CANNOT prove.
      expect(bAcquired).toBe(false);

      await a.query("COMMIT");
      await bPromise;
      expect(bAcquired).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });

  it("locks on DIFFERENT cases don't block each other (locked by (team, case), not a global lock)", async () => {
    const c1 = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        c1.id,
      ]);
      await b.query("BEGIN");
      // Different case id ⇒ different lock ⇒ acquired immediately, no waiting.
      await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        "00000000-0000-0000-0000-0000000000ff",
      ]);
      await b.query("COMMIT");
      await a.query("COMMIT");
      expect(true).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });
});
