/**
 * Coverage gate: a new route that forgets a fixture gets SILENTLY skipped by the L3
 * harness — that is the worst kind of failure (a false green). This test turns that
 * silence into a red CI run.
 *
 * It deliberately does NOT stand up an app/DB: this is a static check on the contract,
 * runs in a few ms, and goes red even when the PGlite harness is broken for an unrelated reason.
 */
import { describe, expect, it } from "vitest";
import { ROUTES, pathParamNames } from "@testkite/contract";
import { BODY_FIXTURES, EXEMPT, RESOURCE_FIXTURES } from "./fixtures.js";

describe("L3 isolation-harness coverage", () => {
  it("every path param has a RESOURCE_FIXTURES entry (or the route is exempt with a reason)", () => {
    const missing: string[] = [];
    for (const r of ROUTES) {
      if (EXEMPT[r.operationId] !== undefined) continue;
      for (const name of pathParamNames(r.path)) {
        if (RESOURCE_FIXTURES[name] === undefined) missing.push(`${r.operationId} -> ${name}`);
      }
    }
    expect(missing, "add a fixture to test/isolation/fixtures.ts").toEqual([]);
  });

  it("every route WITH A BODY that needs an L3 test has a BODY_FIXTURES entry", () => {
    const missing = ROUTES.filter(
      (r) =>
        r.body !== undefined &&
        pathParamNames(r.path).length > 0 &&
        EXEMPT[r.operationId] === undefined &&
        BODY_FIXTURES[r.operationId] === undefined,
    ).map((r) => r.operationId);
    // A missing valid body ⇒ the route returns 400 and hides the 404-vs-403 question.
    expect(missing).toEqual([]);
  });

  it("every exemption has a written reason, not an empty flag", () => {
    for (const [op, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${op}: reason is too short`).toBeGreaterThan(30);
      expect(
        ROUTES.some((r) => r.operationId === op),
        `${op} no longer exists — remove it from EXEMPT`,
      ).toBe(true);
    }
  });

  it("an exemption is only valid for a route WITH a path param — a route with no id has nothing to exempt", () => {
    // Exempting a route with no path param is meaningless (the L3 harness was never
    // targeting it anyway) and dangerous: it teaches whoever comes next that EXEMPT is a
    // place to silence any route.
    for (const op of Object.keys(EXEMPT)) {
      const r = ROUTES.find((x) => x.operationId === op);
      expect(
        pathParamNames(r?.path ?? "").length,
        `${op} has no path param — remove it from EXEMPT`,
      ).toBeGreaterThan(0);
    }
  });

  it("no unused fixtures: every RESOURCE_FIXTURES key is used by at least one route", () => {
    const used = new Set(ROUTES.flatMap((r) => pathParamNames(r.path)));
    for (const key of Object.keys(RESOURCE_FIXTURES)) {
      expect(used.has(key), `fixture "${key}" is used by no route — remove it`).toBe(true);
    }
  });

  it("no unused body fixtures: every BODY_FIXTURES key points at a real operationId", () => {
    const ops = new Set(ROUTES.map((r) => r.operationId));
    for (const key of Object.keys(BODY_FIXTURES)) {
      expect(ops.has(key), `BODY_FIXTURES["${key}"] matches no route — remove it`).toBe(true);
    }
  });
});
