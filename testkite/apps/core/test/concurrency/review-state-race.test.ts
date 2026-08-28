/**
 * The CONCURRENCY test layer for the REVIEW STATE MACHINE — runs ONLY on REAL Postgres.
 *
 * WHY THIS DOESN'T LIVE IN THE PGlite LAYER: `submitForReview` / `withdrawReview` / `decideReview`
 * all go through `loadForMutation` — read `version`, compare with `expectedVersion`, then write:
 * check-then-act exactly like `replaceSteps` (see case-edit-race.test.ts). PGlite has only ONE
 * wasm connection, so two "parallel" `withTenant` calls there queue sequentially and never
 * touch the window between "read version" and "write". Proof only exists here.
 *
 * Two bugs are reproduced here (measured for real before the fix):
 *  1. `decide('approved')` in parallel with `withdraw`, same `expectedVersion` ⇒ BOTH return
 *     success, but the DB can only hold one decision — a SILENT LOST UPDATE: the loser's
 *     response describes a state that doesn't exist in the DB.
 *  2. Two parallel `submitForReview` calls ⇒ the loser hits a unique constraint (revision_no /
 *     `aut_case_reviews_one_open`) and throws a RAW DrizzleQueryError/23505 instead of the
 *     409 `VersionConflictError` contract.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the whole suite skips (`bash scripts/test-pg.sh start` to
 * spin up a temporary cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  submitForReview,
  withdrawReview,
} from "../../src/modules/authoring/review-service.js";
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

/** Split the two branches of `Promise.allSettled` without needing `!` or a cast. */
function splitResults(results: readonly PromiseSettledResult<CaseSummaryDto>[]): {
  readonly won: readonly CaseSummaryDto[];
  readonly lost: readonly unknown[];
} {
  const won: CaseSummaryDto[] = [];
  const lost: unknown[] = [];
  for (const res of results) {
    if (res.status === "fulfilled") won.push(res.value);
    else lost.push(res.reason);
  }
  return { won, lost };
}

function onlyWinner(won: readonly CaseSummaryDto[]): CaseSummaryDto {
  const [first] = won;
  if (first === undefined) throw new Error("nobody won — both sides failed");
  return first;
}

describeRealPg("review state machine under REAL contention (real Postgres, two connections)", () => {
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

  /** A draft case that already has a step (submit requires the case to have a real revision). */
  const seedDraftWithSteps = async (): Promise<CaseSummaryDto> => {
    const created = await withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    return withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: created.id,
        expectedVersion: created.version,
        steps: oneStep("open login page"),
      }),
    );
  };

  const caseRowOf = async (caseId: string): Promise<{ version: number; status: string }> => {
    const row = await r.db.execute(
      sql`SELECT version, status FROM aut_cases WHERE id = ${caseId}`,
    );
    return {
      version: Number(row.rows[0]?.["version"]),
      status: String(row.rows[0]?.["status"]),
    };
  };

  it("two parallel submits with the same expectedVersion: one wins, the loser gets a CLEAN 409 (not a raw 23505)", async () => {
    const c = await seedDraftWithSteps();
    const gate = makeGate(2);

    const submit = (actor: { userId: string }): Promise<CaseSummaryDto> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return submitForReview(tx, ctx(), actor, { caseId: c.id, expectedVersion: c.version });
      });

    const { won, lost } = splitResults(await Promise.allSettled([submit(alice), submit(bob)]));

    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const winner = onlyWinner(won);
    expect(winner.status).toBe("in_review");
    expect(winner.version).toBe(c.version + 1);
    for (const reason of lost) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.code).toBe("version_conflict");
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(c.version);
      expect(conflict.diff.currentVersion).toBe(c.version + 1);
      // submit sends no payload, so the "mine" branch is empty (the conflictFor contract).
      expect(conflict.diff.mine).toEqual([]);
    }

    // The loser rolls back cleanly: exactly ONE open review, the DB matches the winner's response.
    const reviews = await r.db.execute(
      sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(reviews.rows.map((x) => x["state"])).toEqual(["open"]);
    expect(await caseRowOf(c.id)).toEqual({ version: winner.version, status: winner.status });
  });

  it("decide(approved) in parallel with withdraw, same expectedVersion: NO lost update — the loser gets 409, DB matches the winner", async () => {
    const c = await seedDraftWithSteps();
    const submitted = await withTenant(r.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const gate = makeGate(2);

    const decide = withTenant(r.db, ctx(), async (tx) => {
      await gate();
      return decideReview(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: submitted.version,
        decision: "approved",
      });
    });
    const withdraw = withTenant(r.db, ctx(), async (tx) => {
      await gate();
      return withdrawReview(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: submitted.version,
      });
    });

    const { won, lost } = splitResults(await Promise.allSettled([decide, withdraw]));

    // The bug must die right here: WITHOUT the lock, both would "succeed" and the DB can only
    // hold one decision — the loser gets back a state that doesn't actually exist.
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const winner = onlyWinner(won);
    expect(winner.version).toBe(submitted.version + 1);
    for (const reason of lost) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(submitted.version);
      expect(conflict.diff.currentVersion).toBe(submitted.version + 1);
    }

    // DB matches EXACTLY the winner's response: approve keeps in_review, withdraw returns to draft.
    const reviews = await r.db.execute(
      sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(reviews.rows.map((x) => x["state"])).toEqual([
      winner.status === "in_review" ? "approved" : "withdrawn",
    ]);
    expect(await caseRowOf(c.id)).toEqual({ version: winner.version, status: winner.status });
  });
});
