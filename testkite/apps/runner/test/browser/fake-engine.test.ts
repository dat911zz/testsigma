/**
 * HONESTY NOTE — what these tests do and do not prove.
 *
 * Everything here runs against `FakeBrowserEngine`: a hand-written stand-in with no chromium
 * behind it. Passing proves only that the fake honours the `BrowserEngine` contract, so that
 * executor/worker/governance suites built on top of it are deterministic and browser-free.
 * It proves NOTHING about a real browser: not that a context is really isolated, not that
 * `close()` really cancels an in-flight action, not that renderer pids can really be attributed
 * to a context, not that CDP really emits WebP. Those claims belong to Task 12
 * (`PlaywrightBrowserEngine`), which drives real chromium; a green run here is never evidence
 * for them.
 */
import { describe, expect, it } from "vitest";
import { FakeBrowserEngine } from "../../src/browser/fake-engine.js";
import { budgetForChain } from "../../src/executor/timeouts.js";

const opts = { contextId: "ctx-1", baseUrl: "https://staging.example.test", timeouts: budgetForChain(5), trace: false };

describe("FakeBrowserEngine", () => {
  it("hands out a context that reports itself open, then closed", async () => {
    const engine = new FakeBrowserEngine();
    const ctx = await engine.newChainContext(opts);
    expect(ctx.closed).toBe(false);
    await ctx.close();
    expect(ctx.closed).toBe(true);
  });

  it("counts contexts served — the input to the recycle rule", async () => {
    const engine = new FakeBrowserEngine();
    for (let i = 0; i < 3; i++) await (await engine.newChainContext({ ...opts, contextId: `c${i}` })).close();
    expect(engine.contextsServed()).toBe(3);
  });

  it("exposes an OpContext carrying the step timeout the executor chose", async () => {
    const engine = new FakeBrowserEngine();
    const ctx = await engine.newChainContext(opts);
    expect(ctx.opContext(60_000, () => {}).stepTimeoutMs).toBe(60_000);
  });

  it("returns scripted screenshot bytes so ring-buffer tests are deterministic", async () => {
    const engine = new FakeBrowserEngine();
    engine.setScreenshot(Buffer.from("webp-a"));
    const ctx = await engine.newChainContext(opts);
    expect((await ctx.screenshotWebp()).toString()).toBe("webp-a");
  });

  it("reports scripted renderer RSS so the L3 monitor can be driven without a browser", async () => {
    const engine = new FakeBrowserEngine();
    const ctx = await engine.newChainContext(opts);
    engine.setRendererRss("ctx-1", 480 * 1024 * 1024);
    expect(engine.rendererRssFor("ctx-1")).toBe(480 * 1024 * 1024);
    expect(ctx.rendererPids().length).toBeGreaterThan(0);
  });

  it("can be scripted to fail context creation, so infra-error paths are testable", async () => {
    const engine = new FakeBrowserEngine();
    engine.failNextContext(new Error("browser has crashed"));
    await expect(engine.newChainContext(opts)).rejects.toThrow(/crashed/);
  });

  it("records whether tracing was stopped with a path (kept) or null (discarded)", async () => {
    const engine = new FakeBrowserEngine();
    const ctx = await engine.newChainContext({ ...opts, trace: true });
    await ctx.stopTracing("/scratch/trace.zip");
    expect(engine.tracesKept).toEqual(["/scratch/trace.zip"]);
    const ctx2 = await engine.newChainContext({ ...opts, contextId: "ctx-2", trace: true });
    await ctx2.stopTracing(null);
    expect(engine.tracesDiscarded).toBe(1);
  });
});
