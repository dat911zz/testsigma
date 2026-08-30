import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "../src/config.js";
import { MEMORY } from "../src/memory-governance.js";

const base = {
  RUNNER_LANE: "batch",
  RUNNER_WORKER_NAME: "host1-w1",
  CONTROL_PLANE_URL: "http://control-plane.internal:8080",
  RUNNER_BOOTSTRAP_TOKEN: "bootstrap-secret",
  RUNNER_WORKSPACE_DIR: "/var/lib/testkite/w1",
};

describe("loadRunnerConfig", () => {
  it("parses a complete environment and applies defaults", () => {
    const cfg = loadRunnerConfig(base);
    expect(cfg.lane).toBe("batch");
    expect(cfg.controlPlaneUrl).toBe("http://control-plane.internal:8080");
    expect(cfg.claimIdleMs).toBe(1_000);
    expect(cfg.heartbeatIntervalMs).toBe(5_000);
  });

  it("rejects an unknown lane instead of silently defaulting", () => {
    expect(() => loadRunnerConfig({ ...base, RUNNER_LANE: "turbo" })).toThrow(/RUNNER_LANE/);
  });

  it("rejects a missing control plane url", () => {
    const { CONTROL_PLANE_URL: _drop, ...without } = base;
    expect(() => loadRunnerConfig(without)).toThrow(/CONTROL_PLANE_URL/);
  });

  it("never accepts a database url — the worker is zero-credential", () => {
    const cfg = loadRunnerConfig({ ...base, DATABASE_URL: "postgres://user:pw@db/testkite" });
    expect(Object.values(cfg)).not.toContain("postgres://user:pw@db/testkite");
    expect(Object.keys(cfg)).not.toContain("databaseUrl");
  });

  it("derives the slot count and the container ceiling from MEMORY, never from the environment", () => {
    const batch = loadRunnerConfig(base);
    expect(batch.maxContexts).toBe(MEMORY.contextsPerWorker.batch);
    expect(batch.containerLimitBytes).toBe(MEMORY.containerLimitMb.batch * 1024 * 1024);

    const interactive = loadRunnerConfig({
      ...base,
      RUNNER_LANE: "interactive",
      RUNNER_CONTEXTS_PER_WORKER: "99",
      RUNNER_CONTAINER_LIMIT_MB: "99999",
    });
    expect(interactive.maxContexts).toBe(MEMORY.contextsPerWorker.interactive);
    expect(interactive.containerLimitBytes).toBe(MEMORY.containerLimitMb.interactive * 1024 * 1024);
  });

  it("coerces the numeric overrides that are actually tunable", () => {
    const cfg = loadRunnerConfig({ ...base, RUNNER_CLAIM_IDLE_MS: "250", RUNNER_HEARTBEAT_INTERVAL_MS: "2500" });
    expect(cfg.claimIdleMs).toBe(250);
    expect(cfg.heartbeatIntervalMs).toBe(2_500);
  });

  it("rejects a non-positive interval rather than spinning the claim loop at zero delay", () => {
    expect(() => loadRunnerConfig({ ...base, RUNNER_CLAIM_IDLE_MS: "0" })).toThrow(/RUNNER_CLAIM_IDLE_MS/);
  });
});
