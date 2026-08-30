import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OOM_SCORE_CHROMIUM, OOM_SCORE_NODE, setOomScoreAdj } from "../../src/memory/oom-score.js";
import { hasCapSysResource, withLiveProcess } from "../harness/proc.js";

/**
 * These run against the REAL `/proc` and a REAL child process, so they prove what the kernel
 * accepts — unlike the fake-proc cases in oom-reporter.test.ts, which only prove the bytes and
 * the path. The raise path (+500 on chromium's pid) is the one this sandbox can prove; the
 * negative value for node is capability-dependent and is gated in test/host/oom-score.test.ts.
 */
describe("setOomScoreAdj against the real /proc", () => {
  it("raises another live process to the chromium value without any privilege", async () => {
    await withLiveProcess((pid) => {
      expect(setOomScoreAdj(pid, OOM_SCORE_CHROMIUM)).toBe("applied");
      expect(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim()).toBe("500");
    });
  });

  it("keeps the chromium victim marked even when the node value is refused", async () => {
    await withLiveProcess((pid) => {
      expect(setOomScoreAdj(pid, OOM_SCORE_CHROMIUM)).toBe("applied");
      // Lowering below the current value is the call that needs CAP_SYS_RESOURCE. Whatever the
      // kernel answers, the process must survive the attempt and keep the raise it already got.
      const outcome = setOomScoreAdj(pid, OOM_SCORE_NODE);
      expect(outcome).toBe(hasCapSysResource() ? "applied" : "denied");
      const readBack = readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim();
      expect(readBack).toBe(hasCapSysResource() ? "-500" : "500");
    });
  });

  it("answers denied instead of throwing for a pid that no longer exists", () => {
    // A renderer can die between the pid snapshot and the write; that is a race, not a crash.
    // 8388607 is above the 2^22 ceiling Linux allows for pid_max, so no such pid can exist.
    expect(setOomScoreAdj(8_388_607, OOM_SCORE_CHROMIUM)).toBe("denied");
  });
});

/**
 * The capability probe decides whether the host-only tests RUN at all. A wrong bit index would
 * make them skip forever on every box, and a permanently skipped gate reads exactly like a
 * passing one — so the probe itself is pinned against both masks here.
 */
describe("hasCapSysResource", () => {
  function procWithCapEff(capEff: string): string {
    const root = mkdtempSync(join(tmpdir(), "tk-capproc-"));
    mkdirSync(join(root, "self"));
    writeFileSync(join(root, "self", "status"), `Name:\tnode\nCapEff:\t${capEff}\nSeccomp:\t0\n`);
    return root;
  }

  it("reads CAP_SYS_RESOURCE as present when bit 24 is set", () => {
    expect(hasCapSysResource(procWithCapEff("000001ffffffffff"))).toBe(true);
  });

  it("reads it as absent for the mask this sandbox actually reports", () => {
    // Exactly the CapEff of the 2026-08-29 spike box, where `-500` returned EACCES as uid 0.
    expect(hasCapSysResource(procWithCapEff("000001fffeffffff"))).toBe(false);
  });

  it("treats an unreadable status file as no capability rather than throwing", () => {
    expect(hasCapSysResource(mkdtempSync(join(tmpdir(), "tk-nostatus-")))).toBe(false);
  });
});
