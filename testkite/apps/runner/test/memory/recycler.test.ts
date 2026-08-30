import { describe, expect, it } from "vitest";
import { MEMORY } from "../../src/memory-governance.js";
import { browserRecycleReason, containerRecycleReason } from "../../src/memory/recycler.js";

const MB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;
const healthyBrowser = { contextsServed: 1, startedAtMs: 0, rssBytes: 200 * MB, crashed: false };

describe("browserRecycleReason", () => {
  it("keeps a healthy browser", () => {
    expect(browserRecycleReason(healthyBrowser, 60_000)).toBeNull();
  });

  it("recycles after MEMORY.recycle.browserAfterContexts (50) contexts", () => {
    expect(MEMORY.recycle.browserAfterContexts).toBe(50);
    expect(browserRecycleReason({ ...healthyBrowser, contextsServed: 50 }, 1_000)).toBe("contexts");
  });

  it("recycles after 45 minutes", () => {
    expect(MEMORY.recycle.browserAfterMinutes).toBe(45);
    expect(browserRecycleReason(healthyBrowser, 45 * MIN)).toBe("age");
  });

  it("recycles above 1400MB RSS", () => {
    expect(MEMORY.recycle.browserAboveRssMb).toBe(1_400);
    expect(browserRecycleReason({ ...healthyBrowser, rssBytes: 1_400 * MB }, 1_000)).toBe("rss");
  });

  it("recycles a crashed browser before anything else", () => {
    expect(browserRecycleReason({ ...healthyBrowser, crashed: true }, 1_000)).toBe("crash");
  });

  it("reports crash even when every other threshold is also breached", () => {
    expect(
      browserRecycleReason(
        { contextsServed: 50, startedAtMs: 0, rssBytes: 1_400 * MB, crashed: true },
        45 * MIN,
      ),
    ).toBe("crash");
  });

  it("does not recycle a browser measured at the spike's steady state (212MB after 30 contexts)", () => {
    expect(
      browserRecycleReason({ contextsServed: 30, startedAtMs: 0, rssBytes: 213 * MB, crashed: false }, 10 * MIN),
    ).toBeNull();
  });
});

describe("containerRecycleReason", () => {
  const healthy = { jobsDone: 10, startedAtMs: 0, rssFloorBytes: 95 * MB, baselineRssFloorBytes: 87 * MB };

  it("keeps a healthy container", () => {
    expect(containerRecycleReason(healthy, HOUR)).toBeNull();
  });

  it("recycles after 500 jobs", () => {
    expect(MEMORY.recycle.containerAfterJobs).toBe(500);
    expect(containerRecycleReason({ ...healthy, jobsDone: 500 }, HOUR)).toBe("jobs");
  });

  it("recycles after 12 hours", () => {
    expect(MEMORY.recycle.containerAfterHours).toBe(12);
    expect(containerRecycleReason(healthy, 12 * HOUR)).toBe("age");
  });

  it("recycles when the RSS floor grew past 130% of baseline (leak detector)", () => {
    expect(MEMORY.recycle.containerRssFloorGrowthPct).toBe(130);
    expect(containerRecycleReason({ ...healthy, rssFloorBytes: 114 * MB }, HOUR)).toBe("rss-floor-growth");
  });

  it("does NOT fire the leak detector on the spike's real drift (87.0MB -> 95.3MB = 110%)", () => {
    expect(
      containerRecycleReason({ jobsDone: 30, startedAtMs: 0, rssFloorBytes: 95.3 * MB, baselineRssFloorBytes: 87 * MB }, HOUR),
    ).toBeNull();
  });

  it("ignores a zero baseline instead of dividing by zero", () => {
    expect(containerRecycleReason({ ...healthy, baselineRssFloorBytes: 0 }, HOUR)).toBeNull();
  });
});
