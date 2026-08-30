import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { OOM_SCORE_CHROMIUM, OOM_SCORE_NODE, setOomScoreAdj } from "../../src/memory/oom-score.js";
import { describeHostCapSysResource, withLiveProcess } from "../harness/proc.js";

/**
 * Runs ONLY under `pnpm --filter @testkite/runner test:host` on a box that holds
 * CAP_SYS_RESOURCE. The negative half of the L2 contract lives here and nowhere else: the dev
 * sandbox provably cannot lower `oom_score_adj` (spike 2026-08-29 measured EACCES even as uid
 * 0), so a green default suite must never be read as "node is protected from the OOM killer".
 */
describeHostCapSysResource("oom_score_adj on a privileged host", () => {
  it("lowers a live process to OOM_SCORE_NODE so the reporter survives the kill", async () => {
    await withLiveProcess((pid) => {
      expect(setOomScoreAdj(pid, OOM_SCORE_NODE)).toBe("applied");
      expect(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim()).toBe("-500");
    });
  });

  it("still raises to OOM_SCORE_CHROMIUM after a lower, the two calls being independent", async () => {
    await withLiveProcess((pid) => {
      expect(setOomScoreAdj(pid, OOM_SCORE_NODE)).toBe("applied");
      expect(setOomScoreAdj(pid, OOM_SCORE_CHROMIUM)).toBe("applied");
      expect(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim()).toBe("500");
    });
  });
});
