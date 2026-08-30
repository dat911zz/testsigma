import { describe, expect, it } from "vitest";
import { MEMORY } from "../../src/memory-governance.js";
import { planShedding, shedLevel, type ShedCandidate } from "../../src/memory/shedder.js";

const LIMIT = 3072 * 1024 * 1024; // batch container
/**
 * Smallest byte count that is genuinely AT p% of the limit. Rounding down instead would land a
 * fraction of a byte BELOW the threshold (85% of 3072MB is 2738041651.2 bytes, floored to
 * 84.999999993%), so a test named "at 85%" would in fact assert the level just under it and the
 * inclusive boundary would never be covered.
 */
const pct = (p: number) => Math.ceil((LIMIT * p) / 100);

describe("shedLevel", () => {
  it("uses the thresholds frozen in memory-governance (75/85/92)", () => {
    expect(MEMORY.shedThresholdsPct).toEqual([75, 85, 92]);
  });

  it("is green below 75%", () => {
    expect(shedLevel(pct(74), LIMIT)).toBe("green");
  });

  it("stops admitting at 75%", () => {
    expect(shedLevel(pct(75), LIMIT)).toBe("stop-admitting");
  });

  it("aborts the largest context at 85%", () => {
    expect(shedLevel(pct(85), LIMIT)).toBe("abort-largest");
  });

  it("fails the youngest context at 92%", () => {
    expect(shedLevel(pct(92), LIMIT)).toBe("fail-youngest");
  });

  it("treats an unlimited container as green rather than dividing by Infinity into NaN", () => {
    expect(shedLevel(pct(99), Number.POSITIVE_INFINITY)).toBe("green");
  });
});

describe("planShedding", () => {
  const contexts: readonly ShedCandidate[] = [
    { contextId: "old-big", rssBytes: 500 * 1024 * 1024, startedAtMs: 1_000 },
    { contextId: "young-small", rssBytes: 80 * 1024 * 1024, startedAtMs: 9_000 },
  ];

  it("keeps admitting while green", () => {
    const a = planShedding(pct(10), LIMIT, contexts);
    expect(a).toEqual({ level: "green", admit: true, abortContextIds: [] });
  });

  it("stops admitting but aborts nobody at 75%", () => {
    const a = planShedding(pct(76), LIMIT, contexts);
    expect(a.admit).toBe(false);
    expect(a.abortContextIds).toEqual([]);
  });

  it("aborts the LARGEST context at 85% — most memory freed per casualty", () => {
    expect(planShedding(pct(86), LIMIT, contexts).abortContextIds).toEqual(["old-big"]);
  });

  it("fails the YOUNGEST context at 92% — least work thrown away", () => {
    expect(planShedding(pct(93), LIMIT, contexts).abortContextIds).toEqual(["young-small"]);
  });

  it("aborts nothing when there is no context to sacrifice", () => {
    expect(planShedding(pct(99), LIMIT, []).abortContextIds).toEqual([]);
  });
});
