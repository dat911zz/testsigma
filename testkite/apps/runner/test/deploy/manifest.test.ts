import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY } from "../../src/memory-governance.js";

/**
 * WHAT THIS SUITE PROVES, AND WHAT IT CANNOT.
 *
 * It proves the deploy tree agrees with `memory-governance.ts` — one source of truth for the
 * four ceilings instead of two that drift. That is a TEXT check: it reads the unit files and the
 * manifest as data.
 *
 * It proves NOTHING about systemd actually applying those directives: this sandbox has no
 * systemd (PID 1 is `process_api`, `/run/systemd/system` does not exist), and CI's ubuntu runner
 * does not boot the fleet either. Two separate gates cover the rest:
 *   - syntax/typo:  `scripts/verify-units.sh` (offline `systemd-analyze verify`, output-parsed),
 *                   self-proven in `verify-units.test.ts`;
 *   - real effect:  a host pilot — `systemctl start ts-worker@1`, then read the slice's
 *                   `memory.max` out of the unified hierarchy. Nothing here substitutes for it.
 */
const deployDir = join(import.meta.dirname, "..", "..", "deploy");
const manifest = JSON.parse(readFileSync(join(deployDir, "runner-manifest.json"), "utf8")) as {
  lanes: Record<string, { memoryMb: number; contexts: number; swap: boolean }>;
  browserCgroupReserveMb: number;
  slice: { memoryHighPct: number; memoryMaxPct: number };
};
const unit = (name: string): string => readFileSync(join(deployDir, "systemd", name), "utf8");

describe("runner manifest", () => {
  it("matches MEMORY.containerLimitMb exactly — one source of truth, not two", () => {
    expect(manifest.lanes["batch"]?.memoryMb).toBe(MEMORY.containerLimitMb.batch);
    expect(manifest.lanes["interactive"]?.memoryMb).toBe(MEMORY.containerLimitMb.interactive);
  });

  it("matches MEMORY.contextsPerWorker", () => {
    expect(manifest.lanes["batch"]?.contexts).toBe(MEMORY.contextsPerWorker.batch);
    expect(manifest.lanes["interactive"]?.contexts).toBe(MEMORY.contextsPerWorker.interactive);
  });

  it("matches the browser cgroup reserve", () => {
    expect(manifest.browserCgroupReserveMb).toBe(MEMORY.browserCgroupReserveMb);
  });

  it("keeps swap OFF on every lane — swap turns an OOM into an unbounded slowdown", () => {
    for (const lane of Object.values(manifest.lanes)) expect(lane.swap).toBe(false);
  });

  it("declares a memory limit for EVERY lane (the CI rule from blueprint §1)", () => {
    for (const [name, lane] of Object.entries(manifest.lanes)) {
      expect(lane.memoryMb, `lane ${name} has no memory limit`).toBeGreaterThan(0);
    }
  });
});

describe("systemd units", () => {
  it("caps the slice at the documented 80%/88%", () => {
    const slice = unit("ts-workers.slice");
    expect(slice).toContain(`MemoryHigh=${manifest.slice.memoryHighPct}%`);
    expect(slice).toContain(`MemoryMax=${manifest.slice.memoryMaxPct}%`);
  });

  it("sets OOMPolicy=continue on the worker template so Node survives to report browser_oom", () => {
    expect(unit("ts-worker@.service")).toContain("OOMPolicy=continue");
  });

  it("restarts a worker always", () => {
    expect(unit("ts-worker@.service")).toContain("Restart=always");
  });

  it("runs the worker container with the manifest's memory limit and no swap headroom", () => {
    const service = unit("ts-worker@.service");
    expect(service).toContain("--memory 3g");
    expect(service).toContain("--memory-swap 3g"); // equal ⇒ swap disabled for this container
  });

  it("drops every capability and runs as an unprivileged uid", () => {
    const service = unit("ts-worker@.service");
    expect(service).toContain("--cap-drop ALL");
    expect(service).toContain("--user 10001:10001");
    expect(service).toContain("--read-only");
  });

  it("NEVER passes --no-sandbox anywhere in the deploy tree", () => {
    for (const name of ["ts-worker@.service", "runnerd.service", "ts-workers.slice"]) {
      expect(unit(name)).not.toContain("no-sandbox");
    }
  });

  it("keeps runnerd OUT of the worker slice so it survives the pressure it reports", () => {
    const runnerd = unit("runnerd.service");
    expect(runnerd).not.toContain("Slice=ts-workers.slice");
    expect(runnerd).toContain("OOMScoreAdjust=-800");
  });
});
