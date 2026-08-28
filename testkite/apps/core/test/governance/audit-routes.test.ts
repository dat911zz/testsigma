/**
 * `GET /v1/audit-events` over HTTP. The audit log is the one surface where a leak is
 * silent — nobody notices reading a row they shouldn't — so the tenant boundary is
 * asserted against what the DB actually holds for the OTHER team, not just against an
 * empty result.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";

let h: TestApp;
beforeAll(async () => {
  h = await makeTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
});

const auth = (secret: string): { authorization: string } => ({ authorization: `Bearer ${secret}` });

/** Produces one real audit event (`token.issue`) for the team owning `secret`. */
const makeEvent = async (secret: string, name: string): Promise<void> => {
  const r = await h.app.inject({
    method: "POST",
    url: "/v1/tokens",
    headers: auth(secret),
    payload: { name, scopes: ["case:read"], expiresInDays: 30 },
  });
  expect(r.statusCode).toBe(201);
};

const idsInDb = async (teamId: string): Promise<string[]> => {
  const r = await h.db.raw.query<{ id: string }>(`SELECT id FROM audit_events WHERE team_id = $1`, [
    teamId,
  ]);
  return r.rows.map((x) => x.id);
};

const listFor = async (secret: string, query = ""): Promise<{ id: string; action: string }[]> => {
  const r = await h.app.inject({
    method: "GET",
    url: `/v1/audit-events${query}`,
    headers: auth(secret),
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; action: string }[];
};

describe("GET /v1/audit-events", () => {
  it("returns exactly the caller's own team events — never another team's", async () => {
    await makeEvent(h.tokens.adminB, "ci-b");
    await makeEvent(h.tokens.adminA, "ci-a");

    const teamBIds = await idsInDb(h.ids.teamB);
    expect(teamBIds.length, "team B produced no audit row — the test proves nothing").toBeGreaterThan(0);

    const seen = await listFor(h.tokens.adminA);
    expect(new Set(seen.map((x) => x.id))).toEqual(new Set(await idsInDb(h.ids.teamA)));
    for (const id of teamBIds) {
      expect(seen.some((x) => x.id === id), "an event from team B was listed").toBe(false);
    }
  });

  it("each team reads its own log — the filter narrows, it does not empty the list", async () => {
    await makeEvent(h.tokens.adminA, "ci-a");
    await makeEvent(h.tokens.adminB, "ci-b");
    expect((await listFor(h.tokens.adminA)).map((x) => x.action)).toEqual(["token.issue"]);
    expect((await listFor(h.tokens.adminB)).map((x) => x.action)).toEqual(["token.issue"]);
  });

  it("the since/until window still applies alongside the tenant filter", async () => {
    await makeEvent(h.tokens.adminA, "ci-a");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(await listFor(h.tokens.adminA, `?since=${encodeURIComponent(future)}`)).toEqual([]);
    expect((await listFor(h.tokens.adminA, `?since=${encodeURIComponent(past)}`)).length).toBe(1);
    expect(await listFor(h.tokens.adminA, `?until=${encodeURIComponent(past)}`)).toEqual([]);
  });
});
