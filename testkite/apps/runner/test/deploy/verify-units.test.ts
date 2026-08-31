import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE GATE THAT GUARDS THE GATE.
 *
 * `scripts/verify-units.sh` exists because `systemd-analyze verify` (255) returns **exit 0** on a
 * unit whose directives it could not understand — it prints `Unknown key name` / `Invalid memory
 * limit` and carries on. A typo'd `MemoryMax` therefore ships a fleet with NO ceiling while CI
 * stays green, which is precisely the failure class of the old system (docs/SYSTEM_DESIGN.md §1).
 *
 * So this file does not test the units; it tests the GATE, by feeding it a deliberately broken
 * unit in a temp dir and demanding red. It also asserts the trap itself is still live on this
 * machine (raw `systemd-analyze` exits 0 on that same file) — the day systemd starts failing
 * honestly, this assertion is the thing that tells us the output-parsing can be relaxed.
 *
 * The broken fixture is written to a temp dir on purpose: a permanently-broken file inside
 * `deploy/systemd/` would be picked up by the real CI gate and by `manifest.test.ts`.
 *
 * SCOPE: this proves the units PARSE and that the gate reacts to a parse error. It proves nothing
 * about systemd applying the directives — no systemd runs here (PID 1 is `process_api`) or in CI.
 * The slice really capping RAM is host-pilot evidence, not CI evidence.
 */
const scriptPath = join(import.meta.dirname, "..", "..", "..", "..", "scripts", "verify-units.sh");
const deployUnits = join(import.meta.dirname, "..", "..", "deploy", "systemd");

const hasSystemdAnalyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).status === 0;

interface GateRun {
  readonly status: number | null;
  readonly output: string;
}

const runGate = (unitDir: string): GateRun => {
  const proc = spawnSync("bash", [scriptPath, unitDir], { encoding: "utf8" });
  return { status: proc.status, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
};

const withUnitDir = (files: Record<string, string>, fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tk-units-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const BROKEN_UNIT = `[Unit]
Description=deliberately broken fixture

[Service]
Type=exec
ExecStart=/bin/true
MemoryMax=nonsense
OOMPolicyy=continue
`;

// systemd-analyze ships with systemd itself; it is present on the CI image (ubuntu-latest) and in
// the dev sandbox. On a machine without it the gate exits 2 by design, and this suite steps aside
// rather than asserting on a tool that is not there.
describe.skipIf(!hasSystemdAnalyze)("verify-units.sh", () => {
  it("accepts the deploy tree that ships", () => {
    const run = runGate(deployUnits);
    expect(run.output).toContain("ts-workers.slice");
    expect(run.output).toContain("ts-worker@.service");
    expect(run.output).toContain("runnerd.service");
    expect(run.status).toBe(0);
  });

  it("still faces the exit-code trap: systemd-analyze itself blesses a broken unit with exit 0", () => {
    withUnitDir({ "bad.service": BROKEN_UNIT }, (dir) => {
      const raw = spawnSync("systemd-analyze", ["verify", join(dir, "bad.service")], { encoding: "utf8" });
      expect(raw.status, "systemd-analyze now fails honestly; the gate may be simplified").toBe(0);
      expect(`${raw.stdout}${raw.stderr}`).toContain("Unknown key name");
    });
  });

  it("goes RED on that same unit, because it judges OUTPUT and not the exit code", () => {
    withUnitDir({ "bad.service": BROKEN_UNIT }, (dir) => {
      const run = runGate(dir);
      expect(run.status).toBe(1);
      expect(run.output).toContain("Unknown key name 'OOMPolicyy'");
      expect(run.output).toContain("Invalid memory limit");
    });
  });

  it("catches a MISSPELLED memory ceiling — the exact bug that would ship an uncapped fleet", () => {
    withUnitDir(
      { "typo.slice": "[Slice]\nMemoryAccounting=yes\nMemoryMaxx=88%\n" },
      (dir) => {
        const run = runGate(dir);
        expect(run.status).toBe(1);
        expect(run.output).toContain("MemoryMaxx");
      },
    );
  });

  it("tolerates ONLY a missing ExecStart binary — podman and node are absent from the CI runner", () => {
    withUnitDir(
      { "ok.service": "[Service]\nType=exec\nExecStart=/usr/bin/definitely-not-installed --run\n" },
      (dir) => {
        const run = runGate(dir);
        expect(run.status).toBe(0);
        expect(run.output).toContain("ok:");
      },
    );
  });

  it("refuses to pass vacuously when pointed at a directory with no units", () => {
    withUnitDir({}, (dir) => {
      const run = runGate(dir);
      expect(run.status).toBe(2);
      expect(run.output).toContain("no unit files found");
    });
  });

  it("refuses to pass vacuously when the unit directory does not exist", () => {
    const run = runGate(join(tmpdir(), "tk-units-does-not-exist-4c1f"));
    expect(run.status).toBe(2);
    expect(run.output).toContain("unit directory not found");
  });
});
