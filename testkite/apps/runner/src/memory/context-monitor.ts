/**
 * L3 of the four ceilings (docs/SYSTEM_DESIGN.md §5): 350MB soft / 500MB hard per BrowserContext,
 * polled every 5s. One context = one chain, so a context over its ceiling is one tenant's chain
 * misbehaving — the blast radius stops there, and the fleet never has to choose between killing
 * the host and killing a stranger's run.
 *
 * RSS comes from the CONTEXT'S RENDERER PROCESSES, not from the JS heap: the 2026-08-29 spike
 * measured a renderer at 84MB RSS while CDP reported JSHeapUsedSize=866KB. Attribution is
 * verified there too — ballooning one context moved only that context's renderer (84MB → 332MB)
 * and left its neighbour untouched.
 *
 * The timing loop is a thin wrapper over `tick()` so tests drive time explicitly.
 */
import { MEMORY } from "../memory-governance.js";

export type ContextMemoryAction = "ok" | "soft-warn" | "hard-abort";

const SOFT_BYTES = MEMORY.contextSoftMb * 1024 * 1024;
const HARD_BYTES = MEMORY.contextHardMb * 1024 * 1024;

export function classifyContextRss(rssBytes: number): ContextMemoryAction {
  if (rssBytes >= HARD_BYTES) return "hard-abort";
  if (rssBytes >= SOFT_BYTES) return "soft-warn";
  return "ok";
}

export interface ContextSample {
  readonly contextId: string;
  readonly rssBytes: number;
  readonly action: ContextMemoryAction;
}

export interface ContextMonitorDeps {
  /** null = the context's processes are gone; the monitor forgets it rather than scoring it 0. */
  readonly sampleRss: (contextId: string) => number | null;
  readonly onAction: (sample: ContextSample) => void;
}

export class ContextMemoryMonitor {
  readonly #deps: ContextMonitorDeps;
  readonly #registered = new Set<string>();
  readonly #lastAction = new Map<string, ContextMemoryAction>();
  #last: readonly ContextSample[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ContextMonitorDeps) {
    this.#deps = deps;
  }

  register(contextId: string): void {
    this.#registered.add(contextId);
  }

  unregister(contextId: string): void {
    this.#registered.delete(contextId);
    this.#lastAction.delete(contextId);
    this.#last = this.#last.filter((s) => s.contextId !== contextId);
  }

  tick(): readonly ContextSample[] {
    const samples: ContextSample[] = [];
    for (const contextId of this.#registered) {
      const rssBytes = this.#deps.sampleRss(contextId);
      if (rssBytes === null) {
        this.#lastAction.delete(contextId);
        continue;
      }
      const action = classifyContextRss(rssBytes);
      const sample: ContextSample = { contextId, rssBytes, action };
      samples.push(sample);
      // EDGE-triggered, not level-triggered: a context parked above the hard ceiling for a
      // minute must not fire 12 aborts — the first crossing already started the teardown.
      if (this.#lastAction.get(contextId) !== action) {
        this.#lastAction.set(contextId, action);
        this.#deps.onAction(sample);
      }
    }
    this.#last = samples;
    return samples;
  }

  largest(): ContextSample | null {
    let best: ContextSample | null = null;
    for (const s of this.#last) if (best === null || s.rssBytes > best.rssBytes) best = s;
    return best;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.tick(), MEMORY.pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
