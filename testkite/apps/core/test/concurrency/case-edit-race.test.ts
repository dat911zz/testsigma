/**
 * The CONCURRENCY test layer for authoring — runs ONLY on REAL Postgres (multiple connections).
 *
 * WHY THIS DOESN'T LIVE IN THE PGlite LAYER: `replaceSteps` is a classic check-then-act — read
 * `version`, compare with `expectedVersion`, then write. PGlite has only ONE wasm connection,
 * so two "parallel" `withTenant` calls there just queue sequentially: the 8 tests in
 * `test/authoring/case-service.test.ts` all `await` sequentially and NEVER touch the
 * window between "read version" and "write". Proof only exists here.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the whole suite skips (`bash scripts/test-pg.sh start` to
 * spin up a temporary cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { VersionConflictError } from "../../src/modules/authoring/errors.js";
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

/** A manual latch: `wait` only proceeds after someone calls `signal`. */
function makeLatch(): { readonly signal: () => void; readonly wait: Promise<void> } {
  let signal: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { signal: () => signal(), wait };
}

describeRealPg("replaceSteps under REAL contention (real Postgres, two connections)", () => {
  let r: RealDb;
  let teamId = "";
  let projectId = "";
  const alice = { userId: "" };
  const bob = { userId: "" };

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE aut_case_revisions, aut_rest_steps, aut_step_loops, aut_steps, aut_cases,
               memberships, projects, teams, users, organizations RESTART IDENTITY CASCADE`);
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
    const u1 = await r.db.execute(
      sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`,
    );
    const u2 = await r.db.execute(
      sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`,
    );
    alice.userId = String(u1.rows[0]?.["id"]);
    bob.userId = String(u2.rows[0]?.["id"]);
  });

  const ctx = (): { teamId: string } => ({ teamId });

  const oneStep = (sentence: string): StepInputDto[] => [
    { kind: "action", renderedSentence: sentence, verbOpKey: "goto" },
  ];

  const seedCase = async (name: string): Promise<CaseSummaryDto> =>
    withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name, isStepGroup: false }),
    );

  it("two parallel edits with the same expectedVersion: one wins, the loser gets a CLEAN VersionConflictError (not a raw DB error)", async () => {
    const c = await seedCase("Checkout");
    const gate = makeGate(2);

    // Both transactions have BEGUN + SET LOCAL before either gets to read `version`.
    // With no lock, both read version=1 (nobody has committed yet), so BOTH go through
    // the version-comparison branch and both insert step ordinal=1 ⇒ the loser eats a raw 23505.
    const edit = (actor: { userId: string }, sentence: string): Promise<CaseSummaryDto> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return replaceSteps(tx, ctx(), actor, {
          caseId: c.id,
          expectedVersion: c.version,
          steps: oneStep(sentence),
        });
      });

    const results = await Promise.allSettled([
      edit(alice, "alice opens the login page"),
      edit(bob, "bob clicks the cookie banner"),
    ]);
    const won = results.filter(
      (x): x is PromiseFulfilledResult<CaseSummaryDto> => x.status === "fulfilled",
    );
    const lost = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");

    expect(won.map((x) => x.value.version)).toEqual([2]);
    expect(lost.length).toBe(1);
    for (const l of lost) {
      const reason: unknown = l.reason;
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.code).toBe("version_conflict");
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(1);
      expect(conflict.diff.currentVersion).toBe(2);
    }

    // The loser rolls back cleanly: exactly one set of steps, exactly two revisions (#1 create + #2 the winner's).
    const steps = await r.db.execute(
      sql`SELECT rendered_sentence FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`,
    );
    expect(steps.rows.length).toBe(1);
    const revs = await r.db.execute(
      sql`SELECT case_version FROM aut_case_revisions WHERE case_id = ${c.id} ORDER BY revision_no`,
    );
    expect(revs.rows.map((x) => Number(x["case_version"]))).toEqual([1, 2]);
    const row = await r.db.execute(sql`SELECT version FROM aut_cases WHERE id = ${c.id}`);
    expect(Number(row.rows[0]?.["version"])).toBe(2);
  });

  it("locked by (team, case): editing case B is NOT blocked by a transaction holding case A's lock", async () => {
    const a = await seedCase("Case A");
    const b = await seedCase("Case B");
    const locked = makeLatch();
    const release = makeLatch();

    const editA = withTenant(r.db, ctx(), async (tx) => {
      const summary = await replaceSteps(tx, ctx(), alice, {
        caseId: a.id,
        expectedVersion: a.version,
        steps: oneStep("A finished writing, transaction is STILL OPEN so case A's lock is not yet released"),
      });
      locked.signal();
      await release.wait;
      return summary;
    });

    await locked.wait;
    // A global lock (or a table lock) would hang here until the test times out.
    const summaryB = await withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, {
        caseId: b.id,
        expectedVersion: b.version,
        steps: oneStep("B goes through while A still holds its lock"),
      }),
    );
    expect(summaryB.version).toBe(2);

    release.signal();
    expect((await editA).version).toBe(2);
  });
});
