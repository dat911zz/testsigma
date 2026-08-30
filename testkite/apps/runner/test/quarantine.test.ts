import { describe, expect, it } from "vitest";

import { MEMORY } from "../src/memory-governance.js";
import { FleetBreaker, QuarantineDecider, QuarantineLedger } from "../src/quarantine.js";

/**
 * Everything here is pure in-memory bookkeeping over an injected clock, so CI proves the whole
 * decision table for real — there is no fake standing in for a mechanism. What CI does NOT
 * prove is that a real OOM is what calls `onChainOom`: wiring the kernel's verdict into this
 * ledger is the executor's job (T11) and only a host run exercises it end to end.
 */
function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("QuarantineLedger", () => {
  it("quarantines a chain after MEMORY.quarantineAfterOomCount (2) consecutive OOMs", () => {
    expect(MEMORY.quarantineAfterOomCount).toBe(2);
    const led = new QuarantineLedger();
    expect(led.recordOom("chain-a")).toBe(1);
    expect(led.isQuarantined("chain-a")).toBe(false);
    expect(led.recordOom("chain-a")).toBe(2);
    expect(led.isQuarantined("chain-a")).toBe(true);
  });

  it("resets the counter on a successful run — OOMs must be CONSECUTIVE", () => {
    const led = new QuarantineLedger();
    led.recordOom("chain-a");
    led.recordSuccess("chain-a");
    led.recordOom("chain-a");
    expect(led.isQuarantined("chain-a")).toBe(false);
    expect(led.oomCount("chain-a")).toBe(1);
  });

  it("keeps chains independent — one poison chain does not quarantine its neighbour", () => {
    const led = new QuarantineLedger();
    led.recordOom("chain-a");
    led.recordOom("chain-a");
    expect(led.isQuarantined("chain-b")).toBe(false);
  });
});

describe("FleetBreaker", () => {
  it("stays closed below the minimum sample count even at a 100% OOM rate", () => {
    const clock = fixedClock();
    const b = new FleetBreaker({ windowMs: 600_000, minSamples: 10, oomRatePct: 50, now: clock.now });
    for (let i = 0; i < 9; i++) b.record("oom");
    expect(b.isOpen()).toBe(false);
  });

  it("opens once the OOM rate crosses the threshold with enough samples", () => {
    const clock = fixedClock();
    const b = new FleetBreaker({ windowMs: 600_000, minSamples: 10, oomRatePct: 50, now: clock.now });
    for (let i = 0; i < 10; i++) b.record("oom");
    expect(b.isOpen()).toBe(true);
  });

  it("stays closed when the OOM rate is below the threshold", () => {
    const clock = fixedClock();
    const b = new FleetBreaker({ windowMs: 600_000, minSamples: 10, oomRatePct: 50, now: clock.now });
    for (let i = 0; i < 3; i++) b.record("oom");
    for (let i = 0; i < 17; i++) b.record("ok");
    expect(b.isOpen()).toBe(false);
  });

  it("forgets samples older than the window so a fixed incident closes the breaker again", () => {
    const clock = fixedClock();
    const b = new FleetBreaker({ windowMs: 600_000, minSamples: 10, oomRatePct: 50, now: clock.now });
    for (let i = 0; i < 10; i++) b.record("oom");
    expect(b.isOpen()).toBe(true);
    clock.advance(600_001);
    for (let i = 0; i < 10; i++) b.record("ok");
    expect(b.isOpen()).toBe(false);
  });
});

describe("QuarantineDecider", () => {
  it("quarantines a genuine poison chain and raises the poison-chain alert", () => {
    const clock = fixedClock();
    const d = new QuarantineDecider(
      new QuarantineLedger(),
      new FleetBreaker({ windowMs: 600_000, minSamples: 10, oomRatePct: 50, now: clock.now }),
    );
    expect(d.onChainOom("chain-a")).toMatchObject({ quarantined: false, oomCount: 1, alert: null });
    expect(d.onChainOom("chain-a")).toMatchObject({ quarantined: true, oomCount: 2, alert: "poison-chain" });
  });

  it("refuses to quarantine while the fleet breaker is open — the fleet is the suspect, not the chain", () => {
    const clock = fixedClock();
    const breaker = new FleetBreaker({ windowMs: 600_000, minSamples: 4, oomRatePct: 50, now: clock.now });
    const d = new QuarantineDecider(new QuarantineLedger(), breaker);
    for (const key of ["c1", "c2", "c3", "c4"]) d.onChainOom(key);
    const outcome = d.onChainOom("chain-a");
    expect(breaker.isOpen()).toBe(true);
    expect(outcome.quarantined).toBe(false);
    expect(outcome.alert).toBe("fleet-unhealthy");
  });

  it("feeds successes to the breaker so a healthy fleet keeps quarantining poison chains", () => {
    const clock = fixedClock();
    const breaker = new FleetBreaker({ windowMs: 600_000, minSamples: 4, oomRatePct: 50, now: clock.now });
    const d = new QuarantineDecider(new QuarantineLedger(), breaker);
    for (let i = 0; i < 20; i++) d.onChainOk(`ok-${i}`);
    d.onChainOom("chain-a");
    expect(d.onChainOom("chain-a")).toMatchObject({ quarantined: true, alert: "poison-chain" });
  });
});
