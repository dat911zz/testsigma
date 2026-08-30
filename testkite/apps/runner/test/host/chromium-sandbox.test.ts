/**
 * THE PRODUCTION SANDBOX, PROVABLE ONLY OFF ROOT.
 *
 * Chromium's zygote refuses to sandbox a root process ("Running as root without --no-sandbox is
 * not supported", zygote_host_impl_linux.cc:101), and the dev/CI sandbox runs as uid 0. So the
 * one assertion that matters for the fleet — a DEFAULT launch really comes up sandboxed, with no
 * `--no-sandbox` anywhere in the browser's argv — cannot be made in the default suite. It is
 * made here, and it is skipped, never faked, everywhere else.
 *
 * The worker container runs as uid 10001 (docs/SYSTEM_DESIGN.md §5), which is exactly the shape
 * this file measures. Run it with `pnpm --filter @testkite/runner test:host` on a non-root box;
 * the `TESTKITE_HOST_CGROUP` flag is the shared "real host" gate for `test/host/**`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchPlaywrightEngine } from "../../src/browser/playwright-engine.js";

const onNonRootHost = process.env["TESTKITE_HOST_CGROUP"] === "1" && process.getuid?.() !== 0;

(onNonRootHost ? describe : describe.skip)("chromium sandbox on a non-root host", () => {
  it("comes up sandboxed by default — the real cmdline carries no --no-sandbox", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "tk-trace-host-"));
    const engine = await launchPlaywrightEngine({ traceDir });
    try {
      const pid = engine.browserPid();
      expect(pid).not.toBeNull();
      const args = readFileSync(`/proc/${pid ?? 0}/cmdline`, "utf8").split("\0").filter(Boolean);
      expect(args).not.toContain("--no-sandbox");
    } finally {
      await engine.close();
      rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("rejects the root-only opt-out here, so no host run can quietly drop the sandbox", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "tk-trace-host-optout-"));
    try {
      await expect(launchPlaywrightEngine({ traceDir, sandbox: "off-root-dev-only" })).rejects.toThrow(
        /only.*uid 0|uid \d+/,
      );
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });
});
