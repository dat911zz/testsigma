/**
 * A scriptable BrowserEngine. Every executor/worker/governance test runs on this: the logic
 * being proved (verdicts, timeouts, shedding, epoch handling) has nothing to do with chromium,
 * and a browser in those tests would only add flake and seconds.
 *
 * WHAT THIS FAKE IS NOT. It is a script, not a simulator: `close()` here flips a boolean, it does
 * not cancel anything; `rendererPids()` returns invented numbers no `/proc` entry backs;
 * `screenshotWebp()` returns whatever bytes a test handed it, not a WebP frame. So a suite that
 * is green on this engine has proved its OWN logic and nothing about the browser underneath.
 * Real-browser claims are Task 12's, and are made only by tests that launch chromium.
 */
import type { OpContext } from "@testkite/verb-kit";
import type { BrowserEngine, ChainContextOptions, EngineContextHandle } from "./engine.js";

class FakeHandle implements EngineContextHandle {
  readonly contextId: string;
  closed = false;
  readonly #engine: FakeBrowserEngine;
  readonly #pid: number;

  constructor(engine: FakeBrowserEngine, contextId: string, pid: number) {
    this.#engine = engine;
    this.contextId = contextId;
    this.#pid = pid;
  }

  opContext(stepTimeoutMs: number, log: (message: string) => void): OpContext {
    return { page: { contextId: this.contextId }, stepTimeoutMs, log };
  }

  rendererPids(): readonly number[] {
    return [this.#pid];
  }

  async screenshotWebp(): Promise<Buffer> {
    return this.#engine.nextScreenshot();
  }

  async stopTracing(destPath: string | null): Promise<void> {
    if (destPath === null) this.#engine.tracesDiscarded += 1;
    else this.#engine.tracesKept.push(destPath);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#engine.noteClosed(this.contextId);
  }
}

export class FakeBrowserEngine implements BrowserEngine {
  readonly kind = "fake" as const;
  readonly tracesKept: string[] = [];
  tracesDiscarded = 0;
  readonly openContextIds = new Set<string>();
  #served = 0;
  #nextPid = 9000;
  #screenshot = Buffer.from("fake-webp");
  #failNext: Error | null = null;
  #crashed = false;
  readonly #rendererRss = new Map<string, number>();

  async newChainContext(options: ChainContextOptions): Promise<EngineContextHandle> {
    if (this.#failNext !== null) {
      const err = this.#failNext;
      this.#failNext = null;
      throw err;
    }
    this.#served += 1;
    this.openContextIds.add(options.contextId);
    return new FakeHandle(this, options.contextId, this.#nextPid++);
  }

  browserPid(): number | null {
    return 8000;
  }

  contextsServed(): number {
    return this.#served;
  }

  treeRssBytes(): number {
    let total = 0;
    for (const v of this.#rendererRss.values()) total += v;
    return total;
  }

  crashed(): boolean {
    return this.#crashed;
  }

  async close(): Promise<void> {
    this.openContextIds.clear();
  }

  // --- test scripting surface ---
  setScreenshot(bytes: Buffer): void {
    this.#screenshot = bytes;
  }

  nextScreenshot(): Buffer {
    return this.#screenshot;
  }

  setRendererRss(contextId: string, bytes: number): void {
    this.#rendererRss.set(contextId, bytes);
  }

  rendererRssFor(contextId: string): number | null {
    return this.#rendererRss.get(contextId) ?? null;
  }

  failNextContext(err: Error): void {
    this.#failNext = err;
  }

  setCrashed(value: boolean): void {
    this.#crashed = value;
  }

  noteClosed(contextId: string): void {
    this.openContextIds.delete(contextId);
    this.#rendererRss.delete(contextId);
  }
}
