/**
 * The per-worker claim budget behind `429 RATE_LIMITED` on `POST /internal/fleet/claim`
 * (plan "Hop dong cho plan fleet", the error table of `/internal/fleet`).
 *
 * WHAT IT DEFENDS: a worker's claim loop that lost its `claimIdleMs` sleep — a bug the fleet
 * plan can ship at any time, and one that looks like nothing at all from the host: the process
 * is healthy, its jobs pass, and it quietly spends the control plane's database on
 * `FOR UPDATE SKIP LOCKED` scans on behalf of the whole fleet. The budget is per WORKER IDENTITY
 * (taken from the verified worker token, never from the body), so one broken host is throttled
 * and the rest of the fleet keeps claiming.
 *
 * A token bucket, not a fixed window: a healthy worker legitimately claims a burst back to back
 * at startup, filling one slot per request, so a window that refuses the 11th claim of a
 * 16-capacity host would be throttling correct behaviour. `CLAIM_RATE_LIMIT_BURST` covers the
 * largest capacity the contract accepts (asserted in internal-coverage.test.ts).
 *
 * IN PROCESS, ON PURPOSE, and it is a rate limit rather than a quota: an accounting round trip
 * to Postgres per claim would spend exactly the resource the limit exists to protect, and a
 * storm is only interesting while it is happening. Several API instances therefore each grant a
 * budget — the ceiling scales with the fleet's own control plane, which is the honest behaviour
 * for a guard whose job is to keep one spinning worker from crowding out the others, not to
 * meter anything anyone is billed for.
 *
 * `take()` is SYNCHRONOUS with no `await` anywhere inside it. That is not an accident: Node runs
 * one turn of the loop at a time, so a read-modify-write with no suspension point in it cannot
 * interleave with another request's. Introducing an `await` here would make a parallel storm
 * spend far more than one burst (test/concurrency/claim-storm.test.ts is the proof of the
 * property, and would catch its loss).
 */
import { CLAIM_RATE_LIMIT_BURST, CLAIM_RATE_LIMIT_PER_SECOND } from "@testkite/contract";

export type ClaimRateDecision =
  | { readonly allowed: true }
  /** Whole seconds, never below 1 — this is what the `Retry-After` header carries. */
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface ClaimRateLimiter {
  readonly take: (workerId: string, nowMs: number) => ClaimRateDecision;
  /** Workers currently holding a bucket. Exposed so the eviction rule can be asserted. */
  readonly trackedWorkers: () => number;
}

export interface ClaimRateLimiterOptions {
  readonly ratePerSecond?: number;
  readonly burst?: number;
  /** Buckets kept before a sweep runs. Sized well past any real fleet on one control plane. */
  readonly maxTrackedWorkers?: number;
}

const DEFAULT_MAX_TRACKED_WORKERS = 4096;

type Bucket = {
  tokens: number;
  /** Never moves backwards: an NTP step must not read as elapsed time and refill the bucket. */
  updatedMs: number;
};

export function createClaimRateLimiter(options: ClaimRateLimiterOptions = {}): ClaimRateLimiter {
  const ratePerSecond = options.ratePerSecond ?? CLAIM_RATE_LIMIT_PER_SECOND;
  const burst = options.burst ?? CLAIM_RATE_LIMIT_BURST;
  const maxTrackedWorkers = options.maxTrackedWorkers ?? DEFAULT_MAX_TRACKED_WORKERS;
  const buckets = new Map<string, Bucket>();

  const tokensAt = (bucket: Bucket, nowMs: number): number => {
    // A clock that went backwards contributes nothing rather than draining the bucket.
    const elapsedMs = Math.max(0, nowMs - bucket.updatedMs);
    return Math.min(burst, bucket.tokens + (elapsedMs / 1000) * ratePerSecond);
  };

  /**
   * Drops only buckets that have refilled completely. Such a bucket is indistinguishable from a
   * worker that was never seen, so forgetting it changes no future decision — whereas forgetting
   * a SPENT bucket would refund the budget it just used and turn eviction into a way to buy
   * claims. If a sweep frees nothing, every tracked worker is actively spending and the map is
   * bounded by the number of workers doing so.
   */
  const sweep = (nowMs: number): void => {
    for (const [workerId, bucket] of buckets) {
      if (tokensAt(bucket, nowMs) >= burst) buckets.delete(workerId);
    }
  };

  return {
    take: (workerId: string, nowMs: number): ClaimRateDecision => {
      const known = buckets.get(workerId);
      if (known === undefined && buckets.size >= maxTrackedWorkers) sweep(nowMs);
      const bucket = buckets.get(workerId) ?? { tokens: burst, updatedMs: nowMs };
      const tokens = tokensAt(bucket, nowMs);
      const updatedMs = Math.max(bucket.updatedMs, nowMs);

      if (tokens >= 1) {
        buckets.set(workerId, { tokens: tokens - 1, updatedMs });
        return { allowed: true };
      }
      buckets.set(workerId, { tokens, updatedMs });
      // Time until the bucket holds a whole token again, rounded UP to the second the header can
      // express, and never 0 — "retry immediately" is the very behaviour being refused.
      const deficitSeconds = (1 - tokens) / ratePerSecond;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(deficitSeconds)) };
    },
    trackedWorkers: (): number => buckets.size,
  };
}
