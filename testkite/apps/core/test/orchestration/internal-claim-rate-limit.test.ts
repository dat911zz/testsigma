/**
 * The per-worker claim budget behind `429 RATE_LIMITED` (plan "Hop dong cho plan fleet", the
 * error table of `/internal/fleet`).
 *
 * Pure unit level: the bucket takes `nowMs` as an argument rather than reading the clock, so
 * refill can be tested at exact instants instead of with sleeps. The wire behaviour it produces
 * (429 + `Retry-After`) is asserted over HTTP in internal-contract.test.ts, and its behaviour
 * under genuinely parallel requests in test/concurrency/claim-storm.test.ts.
 *
 * What is actually at stake: a worker whose claim loop loses its sleep (a bug the fleet plan can
 * ship at any time) turns into a spin loop against `FOR UPDATE SKIP LOCKED`, and one misbehaving
 * host must not be able to spend the control plane's database on behalf of the whole fleet.
 */
import { describe, expect, it } from "vitest";
import { createClaimRateLimiter } from "../../src/http/internal/claim-rate-limit.js";

const OPTIONS = { ratePerSecond: 10, burst: 20, maxTrackedWorkers: 4 } as const;

describe("claim rate limiter", () => {
  it("spends a full burst before it refuses anything", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    for (let i = 0; i < OPTIONS.burst; i += 1) {
      expect(limiter.take("w-1", 0), `claim ${String(i)} of the burst`).toEqual({ allowed: true });
    }
    expect(limiter.take("w-1", 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("refills at the configured rate, not all at once", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    for (let i = 0; i < OPTIONS.burst; i += 1) limiter.take("w-1", 0);
    // 300ms of refill = 3 tokens, and not a fourth.
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.take("w-1", 300), `refilled claim ${String(i)}`).toEqual({ allowed: true });
    }
    expect(limiter.take("w-1", 300).allowed).toBe(false);
  });

  it("never lets an idle worker bank more than one burst", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    // An hour of silence would be 36 000 tokens if the bucket were uncapped.
    for (let i = 0; i < OPTIONS.burst; i += 1) {
      expect(limiter.take("w-1", 3_600_000), `banked claim ${String(i)}`).toEqual({ allowed: true });
    }
    expect(limiter.take("w-1", 3_600_000).allowed).toBe(false);
  });

  it("budgets every worker separately — one storming host never starves the rest", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    for (let i = 0; i < OPTIONS.burst + 5; i += 1) limiter.take("w-storm", 0);
    expect(limiter.take("w-storm", 0).allowed).toBe(false);
    expect(limiter.take("w-quiet", 0)).toEqual({ allowed: true });
  });

  it("asks for at least one second of backoff — Retry-After has no sub-second gear", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    for (let i = 0; i < OPTIONS.burst; i += 1) limiter.take("w-1", 0);
    // One token is 100ms away, which rounds to the smallest delay the header can express.
    const refused = limiter.take("w-1", 0);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("rounds Retry-After UP to cover the whole deficit of a slower bucket", () => {
    const limiter = createClaimRateLimiter({ ratePerSecond: 0.5, burst: 1, maxTrackedWorkers: 4 });
    expect(limiter.take("w-1", 0)).toEqual({ allowed: true });
    // Half a token per second: a whole token is 2s away, so 1s would still be refused.
    expect(limiter.take("w-1", 0)).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });

  it("hands out nothing extra when the clock jumps backwards", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    for (let i = 0; i < OPTIONS.burst; i += 1) limiter.take("w-1", 10_000);
    // An NTP step backwards must not read as negative elapsed time and refill the bucket.
    expect(limiter.take("w-1", 0).allowed).toBe(false);
    expect(limiter.take("w-1", 10_000).allowed).toBe(false);
  });

  it("forgets only workers whose budget is already full", () => {
    const limiter = createClaimRateLimiter(OPTIONS);
    // Three workers claim once and go quiet: ten seconds later their buckets are full again, so
    // a full bucket carries no information and dropping it changes no future decision.
    for (const id of ["w-a", "w-b", "w-c"]) limiter.take(id, 0);
    const late = 10_000;
    for (let i = 0; i < OPTIONS.burst; i += 1) limiter.take("w-throttled", late);
    expect(limiter.trackedWorkers()).toBe(4);

    // A fifth worker crosses maxTrackedWorkers and triggers the sweep. The three idle buckets go;
    // the throttled one stays, because forgetting a spent bucket would REFUND the whole burst it
    // just used and turn eviction into a way to buy budget.
    expect(limiter.take("w-e", late)).toEqual({ allowed: true });
    expect(limiter.trackedWorkers()).toBe(2);
    expect(limiter.take("w-throttled", late).allowed).toBe(false);
  });
});
