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
 * THE CHROMIUM SANDBOX — READ THIS BEFORE READING A GREEN RUN AS "SANDBOXED". Chromium's zygote
 * refuses to sandbox when the process is root ("Running as root without --no-sandbox is not
 * supported", zygote_host_impl_linux.cc:101) and this dev/CI box IS root. So under root this
 * file opts out EXPLICITLY (`sandbox: "off-root-dev-only"`) and the behaviour tests below run
 * UNSANDBOXED: they prove nothing whatsoever about the production sandbox. What IS proven here:
 * the launcher's sandbox policy (a pure function, no browser needed), the REAL
 * `/proc/<pid>/cmdline` of the browser this file launched, and — on root — that the DEFAULT
 * launch is refused by chromium itself, which can only happen if `chromiumSandbox: true` really
 * reached it. The production shape (uid 10001, sandbox on, launch SUCCEEDS, no `--no-sandbox` in
 * cmdline) is provable only off root: `test/host/chromium-sandbox.test.ts` under `test:host`.
 *
 * WHAT THIS FILE STILL DOES NOT PROVE: cgroup ceilings (`memory.max`/`memory.events`) and a
 * negative `oom_score_adj` — this sandbox is cgroup v1 hybrid without CAP_SYS_RESOURCE, so those
 * live in `test/host/**` behind `pnpm --filter @testkite/runner test:host`.
 *
 * Environment verified 2026-08-29, re-measured 2026-08-30: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers,
 * chromium-headless-shell launches in ~1.1s. The 2026-08-29 note claiming it launched "with the
 * sandbox ON (no --no-sandbox)" was WRONG and is corrected here: playwright-core 1.56.1 defaults
 * `chromiumSandbox` to false and appends `--no-sandbox` unless the option is exactly `true`
 * (lib/server/chromium/chromium.js:288). On a machine with no usable browser the browser-backed
 * half of this file skips on purpose: a real-browser claim must never be "proven" by a fake.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  launchPlaywrightEngine,
  type LaunchOptions,
  type PlaywrightBrowserEngine,
  resolveChromiumSandbox,
} from "../../src/browser/playwright-engine.js";
import { budgetForChain } from "../../src/executor/timeouts.js";
import { readRssBytes } from "../../src/memory/rss.js";

const traceDir = mkdtempSync(join(tmpdir(), "tk-trace-"));

/** The worker container runs as this uid (docs/SYSTEM_DESIGN.md §5) — i.e. never root. */
const WORKER_CONTAINER_UID = 10001;

const rootHere = process.getuid?.() === 0;

/**
 * The opt-out is stated here, in the test that benefits from it, and nowhere else. It is not a
 * default and it is not hidden in the launcher: under root chromium cannot sandbox at all, so a
 * real-browser file either says so out loud or lies about what it measured.
 */
const launchOptions: LaunchOptions = rootHere ? { traceDir, sandbox: "off-root-dev-only" } : { traceDir };

/**
 * Launched at module scope, not in `beforeAll`: `describe.skipIf` is evaluated during
 * COLLECTION, before any hook has run, so a flag set in `beforeAll` would always read its
 * initial value and the skip would never happen.
 */
let launched: PlaywrightBrowserEngine | null = null;
try {
  launched = await launchPlaywrightEngine(launchOptions);
} catch (err) {
  launched = null;
  console.warn(`[playwright-engine.test] no usable chromium here, skipping the real-browser file: ${String(err)}`);
}

const opts = { baseUrl: "https://example.invalid", timeouts: budgetForChain(3), trace: false };

/** Argv of a live process, straight from the kernel — the only honest source for a launch flag. */
function cmdlineOf(pid: number): readonly string[] {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
}

/**
 * No browser needed: this is the launcher's OWN decision, and it is the half of the sandbox
 * story that a root CI box can prove completely.
 */
describe("chromium sandbox policy", () => {
  it("keeps the OS sandbox ON by default — what the worker container gets is not an opt-in", () => {
    expect(resolveChromiumSandbox(undefined, WORKER_CONTAINER_UID)).toBe(true);
    expect(resolveChromiumSandbox("on", WORKER_CONTAINER_UID)).toBe(true);
    expect(resolveChromiumSandbox("on", 0)).toBe(true);
  });

  it("refuses the --no-sandbox opt-out off root, so production cannot ship unsandboxed by accident", () => {
    expect(() => resolveChromiumSandbox("off-root-dev-only", WORKER_CONTAINER_UID)).toThrow(/uid 10001/);
  });

  it("refuses the opt-out where the platform has no uid at all, the safe direction for an unknown", () => {
    expect(() => resolveChromiumSandbox("off-root-dev-only", -1)).toThrow(/uid -1/);
  });

  it("grants the opt-out only to uid 0, the one case where chromium refuses to sandbox anyway", () => {
    expect(resolveChromiumSandbox("off-root-dev-only", 0)).toBe(false);
  });
});

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

    it("states its own sandbox status from the browser's real cmdline, not from a comment", () => {
      const pid = engine.browserPid();
      expect(pid).not.toBeNull();
      const args = cmdlineOf(pid ?? 0);
      // Root here ⇒ this file opted out explicitly, `--no-sandbox` MUST be present, and every
      // other assertion in this describe is an UNSANDBOXED measurement. Off root ⇒ no opt-out is
      // passed, the default applies, and the flag must be absent — the production shape.
      expect(args.includes("--no-sandbox")).toBe(rootHere);
    });

    it.runIf(rootHere)("really asks chromium for the sandbox by default — the zygote's refusal is the proof", async () => {
      // A default launch as root MUST fail. If it ever succeeds here, `chromiumSandbox: true`
      // stopped reaching chromium and the fleet would be shipping `--no-sandbox` again.
      await expect(launchPlaywrightEngine({ traceDir })).rejects.toThrow(
        /Running as root without --no-sandbox is not supported|Chromium sandboxing failed/,
      );
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
