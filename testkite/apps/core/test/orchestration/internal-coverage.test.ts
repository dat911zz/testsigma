/**
 * The same gate idea as test/isolation/coverage.test.ts: a NEW /internal/fleet endpoint that
 * nobody wrote a contract test for would ship unguarded. This turns that silence red.
 * Static check on the descriptor list — no app, no DB, runs in milliseconds.
 */
import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTES, ROUTES, RUN_EVENT_KIND_VALUES } from "@testkite/contract";
import { ARTIFACT_KINDS } from "../../src/modules/results/index.js";
import { RUN_EVENT_KINDS } from "../../src/modules/orchestration/events.js";

/** Endpoints that mutate a job and therefore MUST carry leaseEpoch. */
const EPOCH_REQUIRED = [
  "internalJobHeartbeat",
  "internalEvents",
  "internalArtifacts",
  "internalComplete",
];
const EPOCH_EXEMPT: Record<string, string> = {
  internalRegister: "registration happens before any job exists, so there is no lease to fence",
  internalWorkerHeartbeat:
    "a worker-level heartbeat is about the host, not about any one job's lease",
  internalClaim: "the claim is what CREATES the epoch; requiring one would be circular",
};

describe("/internal/fleet route coverage", () => {
  it("every mutating route requires leaseEpoch in its body schema", () => {
    for (const op of EPOCH_REQUIRED) {
      const r = INTERNAL_ROUTES.find((x) => x.operationId === op);
      expect(r, `${op} is missing from INTERNAL_ROUTES`).toBeDefined();
      expect(
        Object.keys(r?.body?.shape ?? {}),
        `${op} body must carry leaseEpoch`,
      ).toContain("leaseEpoch");
    }
  });

  it("every route is either epoch-required or exempt with a written reason", () => {
    for (const r of INTERNAL_ROUTES) {
      const covered =
        EPOCH_REQUIRED.includes(r.operationId) || EPOCH_EXEMPT[r.operationId] !== undefined;
      expect(
        covered,
        `${r.operationId}: add it to EPOCH_REQUIRED or justify it in EPOCH_EXEMPT`,
      ).toBe(true);
    }
    for (const [op, reason] of Object.entries(EPOCH_EXEMPT)) {
      expect(reason.length, `${op}: reason is too short`).toBeGreaterThan(30);
    }
  });

  it("declares a credential kind on every route", () => {
    for (const r of INTERNAL_ROUTES) expect(["bootstrap", "worker", "run"]).toContain(r.credential);
  });

  it("keeps every path under /internal/fleet and out of the public ROUTES array", () => {
    for (const r of INTERNAL_ROUTES) expect(r.path.startsWith("/internal/fleet/")).toBe(true);
    expect(ROUTES.some((r) => r.path.startsWith("/internal"))).toBe(false);
  });

  it("publishes all seven endpoints of the fleet contract, and no eighth", () => {
    expect(INTERNAL_ROUTES.map((r) => r.operationId)).toEqual([
      "internalRegister",
      "internalWorkerHeartbeat",
      "internalClaim",
      "internalJobHeartbeat",
      "internalEvents",
      "internalArtifacts",
      "internalComplete",
    ]);
  });

  it("keeps the event-kind list identical on both sides of the module boundary", () => {
    // contract cannot import apps/core, so the list exists twice; this is the only thing
    // stopping the two copies from drifting.
    expect([...RUN_EVENT_KIND_VALUES]).toEqual([...RUN_EVENT_KINDS]);
  });

  it("keeps the artifact-kind list identical on both sides of the module boundary", () => {
    // Same duplication, same reason: `res_artifacts` builds its CHECK from ARTIFACT_KINDS,
    // while the wire schema has to state the five values without importing apps/core. A kind
    // the edge accepts but the column refuses would be a 500 on a worker's upload request.
    const wire = INTERNAL_ROUTES.find((r) => r.operationId === "internalArtifacts");
    const kind: unknown = wire?.body?.shape?.["kind"];
    expect(kind).toBeDefined();
    expect((kind as { options: readonly string[] }).options).toEqual([...ARTIFACT_KINDS]);
  });
});
