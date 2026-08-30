/**
 * A chain that OOMs twice in a row is a POISON CHAIN: retrying it burns a browser slot every
 * time and never converges. MEMORY.quarantineAfterOomCount = 2 is the frozen threshold.
 *
 * The breaker exists because that rule inverts under a fleet-wide fault: a bad image or a sick
 * host makes EVERY chain OOM, and a naive ledger would quarantine a customer's whole backlog
 * for OUR failure. So when the fleet-wide OOM rate crosses the threshold, the breaker opens and
 * quarantining stops — the alert changes from "your chain is poison" to "our fleet is sick".
 *
 * Scope of proof: this module is pure bookkeeping over an injected clock, so its decision table
 * is proven for real in CI — no fake stands in for a mechanism here. What CI cannot prove is
 * that a genuine kernel OOM is what drives `onChainOom`; that wiring belongs to the executor
 * (Task 11) and is only exercised end to end on a real host.
 */
import { MEMORY } from "./memory-governance.js";

/** Per-chain counter of CONSECUTIVE OOMs; a single success wipes the chain's history. */
export class QuarantineLedger {
  readonly #consecutiveOom = new Map<string, number>();

  recordOom(chainKey: string): number {
    const next = (this.#consecutiveOom.get(chainKey) ?? 0) + 1;
    this.#consecutiveOom.set(chainKey, next);
    return next;
  }

  recordSuccess(chainKey: string): void {
    this.#consecutiveOom.delete(chainKey);
  }

  oomCount(chainKey: string): number {
    return this.#consecutiveOom.get(chainKey) ?? 0;
  }

  isQuarantined(chainKey: string): boolean {
    return this.oomCount(chainKey) >= MEMORY.quarantineAfterOomCount;
  }
}

export interface FleetBreakerOptions {
  readonly windowMs: number;
  readonly minSamples: number;
  readonly oomRatePct: number;
  readonly now: () => number;
}

interface FleetSample {
  readonly at: number;
  readonly oom: boolean;
}

/**
 * Sliding-window OOM rate over the whole worker. `minSamples` keeps a cold start (the first
 * OOM of the shift being 100% of one sample) from opening the breaker, and the window makes a
 * fixed incident heal on its own instead of latching the breaker open forever.
 */
export class FleetBreaker {
  readonly #opts: FleetBreakerOptions;
  #samples: FleetSample[] = [];

  constructor(opts: FleetBreakerOptions) {
    this.#opts = opts;
  }

  record(kind: "ok" | "oom"): void {
    this.#samples.push({ at: this.#opts.now(), oom: kind === "oom" });
    this.#evict();
  }

  isOpen(): boolean {
    this.#evict();
    if (this.#samples.length < this.#opts.minSamples) return false;
    const ooms = this.#samples.filter((s) => s.oom).length;
    return (ooms / this.#samples.length) * 100 >= this.#opts.oomRatePct;
  }

  #evict(): void {
    const cutoff = this.#opts.now() - this.#opts.windowMs;
    this.#samples = this.#samples.filter((s) => s.at > cutoff);
  }
}

export interface QuarantineOutcome {
  readonly quarantined: boolean;
  readonly oomCount: number;
  readonly alert: "poison-chain" | "fleet-unhealthy" | null;
}

/** Joins the two: the ledger accuses a chain, the breaker vetoes the accusation. */
export class QuarantineDecider {
  readonly #ledger: QuarantineLedger;
  readonly #breaker: FleetBreaker;

  constructor(ledger: QuarantineLedger, breaker: FleetBreaker) {
    this.#ledger = ledger;
    this.#breaker = breaker;
  }

  onChainOom(chainKey: string): QuarantineOutcome {
    this.#breaker.record("oom");
    const oomCount = this.#ledger.recordOom(chainKey);
    if (this.#breaker.isOpen()) {
      return { quarantined: false, oomCount, alert: "fleet-unhealthy" };
    }
    const quarantined = this.#ledger.isQuarantined(chainKey);
    return { quarantined, oomCount, alert: quarantined ? "poison-chain" : null };
  }

  onChainOk(chainKey: string): void {
    this.#breaker.record("ok");
    this.#ledger.recordSuccess(chainKey);
  }
}
