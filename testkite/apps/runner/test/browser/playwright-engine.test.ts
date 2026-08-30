/**
 * THE ONLY TESTS IN THE RUNNER THAT LAUNCH A REAL BROWSER.
 *
 * Everything else in this suite runs on `FakeBrowserEngine`, where `close()` flips a boolean and
 * `rendererPids()` invents numbers. Those tests prove orchestration and nothing about chromium.
 * This file is the other half of the bargain: every claim the fake merely ASSUMES is asserted
 * here against a live chromium-headless-shell — a context owns its own renderer pids, RSS is
 * attributable to the guilty context, CDP emits WebP, tracing writes a real zip, and closing a
 * context leaves no renderer behind.
 *
 * WHAT THIS FILE STILL DOES NOT PROVE: cgroup ceilings (`memory.max`/`memory.events`) and a
 * negative `oom_score_adj` — this sandbox is cgroup v1 hybrid without CAP_SYS_RESOURCE, so those
 * live in `test/host/**` behind `pnpm --filter @testkite/runner test:host`.
 *
 * Environment verified on 2026-08-29: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers,
 * chromium-headless-shell launches in ~1118ms with the chromium sandbox ON (no `--no-sandbox`).
 * On a machine with no usable browser the whole file skips on purpose: a real-browser claim
 * must never be "proven" by a fake standing in for the browser.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchPlaywrightEngine, type PlaywrightBrowserEngine } from "../../src/browser/playwright-engine.js";
import { budgetForChain } from "../../src/executor/timeouts.js";
import { readRssBytes } from "../../src/memory/rss.js";

const traceDir = mkdtempSync(join(tmpdir(), "tk-trace-"));

/**
 * Launched at module scope, not in `beforeAll`: `describe.skipIf` is evaluated during
 * COLLECTION, before any hook has run, so a flag set in `beforeAll` would always read its
 * initial value and the skip would never happen.
 */
let launched: PlaywrightBrowserEngine | null = null;
try {
  launched = await launchPlaywrightEngine({ traceDir });
} catch (err) {
  launched = null;
  console.warn(`[playwright-engine.test] no usable chromium here, skipping the real-browser file: ${String(err)}`);
}

const opts = { baseUrl: "https://example.invalid", timeouts: budgetForChain(3), trace: false };

if (launched === null) {
  rmSync(traceDir, { recursive: true, force: true });
  describe.skip("PlaywrightBrowserEngine (no chromium on this machine)", () => {
    it("is provable only where a real browser exists", () => {
      expect(true).toBe(true);
    });
  });
} else {
  const engine = launched;

  afterAll(async () => {
    await engine.close();
    rmSync(traceDir, { recursive: true, force: true });
  });

  describe("PlaywrightBrowserEngine", () => {
    it("reports a browser pid so the worker can place it in the nested cgroup", () => {
      const pid = engine.browserPid();
      expect(pid).not.toBeNull();
      expect(pid ?? 0).toBeGreaterThan(0);
    });

    it("gives each context its OWN renderer pids (this is what per-context RSS attribution needs)", async () => {
      const a = await engine.newChainContext({ ...opts, contextId: "pids-a" });
      const b = await engine.newChainContext({ ...opts, contextId: "pids-b" });
      const pidsA = a.rendererPids();
      const pidsB = b.rendererPids();

      expect(pidsA.length).toBeGreaterThan(0);
      expect(pidsB.length).toBeGreaterThan(0);
      expect(pidsA.some((p) => pidsB.includes(p))).toBe(false);

      await a.close();
      await b.close();
    });

    it("attributes a memory balloon to the guilty context only", async () => {
      const a = await engine.newChainContext({ ...opts, contextId: "blame-a" });
      const b = await engine.newChainContext({ ...opts, contextId: "blame-b" });
      const before = engine.contextRssBytes("blame-a");

      await engine.evaluateForTest(
        "blame-b",
        "globalThis.__b = []; for (let i = 0; i < 25; i++) globalThis.__b.push(new Uint8Array(8 * 1024 * 1024).fill(1)); globalThis.__b.length;",
      );
      await new Promise((r) => setTimeout(r, 400));

      expect(engine.contextRssBytes("blame-b")).toBeGreaterThan(before + 150 * 1024 * 1024);
      expect(engine.contextRssBytes("blame-a")).toBeLessThan(before + 50 * 1024 * 1024);

      await a.close();
      await b.close();
    });

    it("emits WebP screenshots (the Playwright API cannot, CDP can)", async () => {
      const ctx = await engine.newChainContext({ ...opts, contextId: "shot" });
      const bytes = await ctx.screenshotWebp();

      // RIFF....WEBP magic
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

      await ctx.close();
    });

    it("writes a trace.zip when the trace is kept and no file when it is discarded", async () => {
      const kept = await engine.newChainContext({ ...opts, contextId: "kept", trace: true });
      const path = join(traceDir, "kept.zip");
      await kept.stopTracing(path);
      await kept.close();
      expect(existsSync(path)).toBe(true);

      const dropped = await engine.newChainContext({ ...opts, contextId: "dropped", trace: true });
      await dropped.stopTracing(null);
      await dropped.close();
      expect(existsSync(join(traceDir, "dropped.zip"))).toBe(false);
    });

    it("leaves NO renderer behind after close — this is the anti-leak assertion", async () => {
      const ctx = await engine.newChainContext({ ...opts, contextId: "leak" });
      const pids = [...ctx.rendererPids()];

      await ctx.close();
      await new Promise((r) => setTimeout(r, 500)); // the spike showed reaping is not instant

      expect(pids.map((p) => readRssBytes(p))).toEqual(pids.map(() => null));
    });
  });
}
