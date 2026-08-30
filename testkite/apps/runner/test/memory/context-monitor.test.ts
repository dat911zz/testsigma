import { describe, expect, it, vi } from "vitest";
import { MEMORY } from "../../src/memory-governance.js";
import { classifyContextRss, ContextMemoryMonitor, type ContextSample } from "../../src/memory/context-monitor.js";

const MB = 1024 * 1024;

describe("classifyContextRss", () => {
  it("is ok below the soft ceiling", () => {
    expect(classifyContextRss(349 * MB)).toBe("ok");
  });

  it("warns at exactly the soft ceiling (350MB)", () => {
    expect(MEMORY.contextSoftMb).toBe(350);
    expect(classifyContextRss(350 * MB)).toBe("soft-warn");
  });

  it("aborts at exactly the hard ceiling (500MB)", () => {
    expect(MEMORY.contextHardMb).toBe(500);
    expect(classifyContextRss(500 * MB)).toBe("hard-abort");
  });

  it("aborts above the hard ceiling", () => {
    expect(classifyContextRss(2_000 * MB)).toBe("hard-abort");
  });
});

describe("ContextMemoryMonitor", () => {
  it("polls every registered context and reports each sample", () => {
    const seen: ContextSample[] = [];
    const rss: Record<string, number> = { a: 100 * MB, b: 400 * MB };
    const m = new ContextMemoryMonitor({
      sampleRss: (id) => rss[id] ?? null,
      onAction: (s) => seen.push(s),
    });
    m.register("a");
    m.register("b");
    const samples = m.tick();
    expect(samples.map((s) => s.contextId).sort()).toEqual(["a", "b"]);
    expect(seen.find((s) => s.contextId === "b")?.action).toBe("soft-warn");
    expect(seen.find((s) => s.contextId === "a")?.action).toBe("ok");
  });

  it("emits hard-abort exactly once per crossing, not on every tick", () => {
    const onAction = vi.fn();
    const m = new ContextMemoryMonitor({ sampleRss: () => 600 * MB, onAction });
    m.register("a");
    m.tick();
    m.tick();
    m.tick();
    expect(onAction.mock.calls.filter((c) => (c[0] as ContextSample).action === "hard-abort")).toHaveLength(1);
  });

  it("re-fires when a context recovers and crosses the ceiling again", () => {
    const seen: ContextSample[] = [];
    let rssBytes = 600 * MB;
    const m = new ContextMemoryMonitor({ sampleRss: () => rssBytes, onAction: (s) => seen.push(s) });
    m.register("a");
    m.tick();
    rssBytes = 100 * MB;
    m.tick();
    rssBytes = 600 * MB;
    m.tick();
    expect(seen.map((s) => s.action)).toEqual(["hard-abort", "ok", "hard-abort"]);
  });

  it("names the largest context — this is who the OOM reporter blames", () => {
    const rss: Record<string, number> = { a: 120 * MB, b: 480 * MB, c: 300 * MB };
    const m = new ContextMemoryMonitor({ sampleRss: (id) => rss[id] ?? null, onAction: () => {} });
    for (const id of ["a", "b", "c"]) m.register(id);
    m.tick();
    expect(m.largest()?.contextId).toBe("b");
  });

  it("drops a context that disappeared (renderer already gone) instead of counting it as 0", () => {
    const m = new ContextMemoryMonitor({ sampleRss: () => null, onAction: () => {} });
    m.register("a");
    expect(m.tick()).toEqual([]);
    expect(m.largest()).toBeNull();
  });

  it("stops reporting a context after unregister", () => {
    const onAction = vi.fn();
    const m = new ContextMemoryMonitor({ sampleRss: () => 100 * MB, onAction });
    m.register("a");
    m.unregister("a");
    expect(m.tick()).toEqual([]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("forgets an unregistered context in largest() so a closed context is never blamed", () => {
    const rss: Record<string, number> = { a: 480 * MB, b: 120 * MB };
    const m = new ContextMemoryMonitor({ sampleRss: (id) => rss[id] ?? null, onAction: () => {} });
    m.register("a");
    m.register("b");
    m.tick();
    expect(m.largest()?.contextId).toBe("a");
    m.unregister("a");
    expect(m.largest()?.contextId).toBe("b");
  });

  it("uses MEMORY.pollIntervalMs (5s) for the timer, not a hand-picked number", () => {
    expect(MEMORY.pollIntervalMs).toBe(5_000);
    const spy = vi.spyOn(globalThis, "setInterval");
    const m = new ContextMemoryMonitor({ sampleRss: () => null, onAction: () => {} });
    m.start();
    expect(spy.mock.calls[0]?.[1]).toBe(MEMORY.pollIntervalMs);
    m.stop();
    spy.mockRestore();
  });
});
