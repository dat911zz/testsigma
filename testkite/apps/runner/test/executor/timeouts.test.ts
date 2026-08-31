/**
 * Pure arithmetic over frozen constants — everything here is proven in CI on every machine.
 * What it does NOT prove: that a budget actually STOPS a running action. It cannot; the spike
 * (plan §10) measured a `Promise.race` losing to the Playwright action it was supposed to bound.
 * That truth belongs to the real engine and is asserted in Task 11/12.
 */
import { chainTimeoutSeconds } from "@testkite/run-compiler";
import { describe, expect, it, vi } from "vitest";
import { assertNested, budgetForChain, raceDeadline } from "../../src/executor/timeouts.js";
import { MEMORY } from "../../src/memory-governance.js";

describe("budgetForChain", () => {
  it("takes action/navigation/step straight from MEMORY.timeoutsSec", () => {
    const b = budgetForChain(10);
    expect(b.actionMs).toBe(MEMORY.timeoutsSec.action * 1000);
    expect(b.navigationMs).toBe(MEMORY.timeoutsSec.nav * 1000);
    expect(b.stepMs).toBe(MEMORY.timeoutsSec.step * 1000);
    expect([b.actionMs, b.navigationMs, b.stepMs]).toEqual([15_000, 30_000, 60_000]);
  });

  it("reuses the compiler's chain formula rather than recomputing it", () => {
    for (const steps of [0, 1, 7, 50, 200, 1_000]) {
      expect(budgetForChain(steps).chainMs).toBe(chainTimeoutSeconds(steps) * 1000);
    }
  });

  it("honours the floor of 180s for a tiny chain", () => {
    expect(budgetForChain(1).chainMs).toBe(MEMORY.timeoutsSec.chainMin * 1000);
  });

  it("honours the cap of 900s for a huge chain", () => {
    expect(budgetForChain(10_000).chainMs).toBe(MEMORY.timeoutsSec.chainMax * 1000);
  });

  it("produces a strictly nested budget at every size", () => {
    for (const steps of [1, 5, 25, 100, 500]) expect(() => assertNested(budgetForChain(steps))).not.toThrow();
  });
});

describe("assertNested", () => {
  it("rejects a budget where an action could outlive its step", () => {
    expect(() => assertNested({ actionMs: 70_000, navigationMs: 30_000, stepMs: 60_000, chainMs: 180_000 })).toThrow(
      /action/,
    );
  });

  it("rejects a budget where a step could outlive its chain", () => {
    expect(() => assertNested({ actionMs: 15_000, navigationMs: 30_000, stepMs: 200_000, chainMs: 180_000 })).toThrow(
      /step/,
    );
  });
});

describe("raceDeadline", () => {
  it("returns the work's value when the work wins", async () => {
    await expect(raceDeadline(Promise.resolve("done"), 10_000, () => new Error("deadline"))).resolves.toBe("done");
  });

  it("throws the caller's error when the deadline wins", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(raceDeadline(never, 1, () => new Error("deadline"))).rejects.toThrow("deadline");
  });

  /**
   * The loser of the race is still OBSERVED. `Promise.race` attaches its own handler to `work`,
   * so a rejection that arrives after the deadline already won is delivered to a promise that
   * has handlers — it never reaches `process.on("unhandledRejection")`, which under Node's
   * default `--unhandled-rejections=throw` would take the whole worker process down mid-chain,
   * abandoning a leased job and a live browser. This test is the guard on that property: a
   * refactor that stops racing `work` directly (waiting only on the winner, say) would break it.
   */
  it("does not leak an unhandled rejection when the loser rejects after the deadline fired", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const work = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("the work failed long after it lost the race"));
        }, 20);
      });
      await expect(raceDeadline(work, 1, () => new Error("deadline"))).rejects.toThrow("deadline");
      // Long enough for the loser to reject AND for node to run its unhandled-rejection check.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears the deadline timer whichever side wins", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      await raceDeadline(Promise.resolve(1), 60_000, () => new Error("deadline"));
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
