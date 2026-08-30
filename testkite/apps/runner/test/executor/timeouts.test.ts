/**
 * Pure arithmetic over frozen constants — everything here is proven in CI on every machine.
 * What it does NOT prove: that a budget actually STOPS a running action. It cannot; the spike
 * (plan §10) measured a `Promise.race` losing to the Playwright action it was supposed to bound.
 * That truth belongs to the real engine and is asserted in Task 11/12.
 */
import { chainTimeoutSeconds } from "@testkite/run-compiler";
import { describe, expect, it } from "vitest";
import { assertNested, budgetForChain } from "../../src/executor/timeouts.js";
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
