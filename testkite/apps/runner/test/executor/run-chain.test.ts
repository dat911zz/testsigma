/**
 * HONESTY NOTE — what these tests do and do not prove.
 *
 * Every test in this file runs on `FakeBrowserEngine`. What is proved here is the executor's
 * ORCHESTRATION LOGIC and nothing else: that exactly one context is requested per chain, that
 * the context is closed on every exit path, that a step result / thrown value is mapped onto
 * the right verdict, that a `for` body runs once per frozen loop row, and that an unsupported
 * step kind is refused by name, and that a `for` body binds its row's data into the args
 * the verb receives.
 *
 * It is NOT evidence about a browser. On this fake, `close()` flips a boolean — it cancels
 * nothing. So the assertion "the context was closed" here means "the executor called close()",
 * NOT "the in-flight action was actually cancelled". The 2026-08-29 spike measured that a lost
 * `Promise.race` leaves a Playwright action running to completion and that only closing the
 * context truly stops it; proving that the real engine cancels — and that a real chromium
 * failure arrives shaped the way `classifyError` expects — is Task 12's job, against real
 * chromium. A green run of this file is never evidence for any of that.
 */
import { AssertionFailure, RetryableInfraError } from "@testkite/contract";
import type { CasePlan, ChainPlan, DataRow, RunPolicy, StepPlan } from "@testkite/run-compiler";
import type { VerbDefinition } from "@testkite/verb-kit";
import { describe, expect, it, vi } from "vitest";
import { FakeBrowserEngine } from "../../src/browser/fake-engine.js";
import { runChain, type RunChainDeps } from "../../src/executor/run-chain.js";

const policy: RunPolicy = {
  lane: "batch",
  engine: "chromium-headless-shell",
  retry: "infra-only",
  screenshots: "failure",
  baseUrl: "https://staging.example.test",
};

function actionStep(ordinal: number, opKey = "web.click"): StepPlan {
  return { kind: "action", ordinal, renderedSentence: `Click on button ${ordinal}`, groupPath: [], args: { element: "btn" }, opKey };
}

/** An action step with caller-chosen args — lets a test assert what the verb actually received. */
function argsStep(ordinal: number, args: Record<string, string>): StepPlan {
  return { kind: "action", ordinal, renderedSentence: `Step ${ordinal}`, groupPath: [], args, opKey: "web.click" };
}

/** A frozen loop row, shaped exactly as compiler phase 2 stamps it into the plan. */
function row(label: string, values: Record<string, string>): DataRow {
  return { label, expectedToFail: false, values };
}

function forStep(ordinal: number, rows: readonly DataRow[], children: readonly StepPlan[]): StepPlan {
  return { kind: "for", ordinal, renderedSentence: "For each row", groupPath: [], args: {}, children, loopRows: rows };
}

/** Records every args map the verb was called with, so a test can compare them row by row. */
function recorder(): { readonly seen: Record<string, string>[]; readonly execute: VerbDefinition["execute"] } {
  const seen: Record<string, string>[] = [];
  return {
    seen,
    execute: async (_ctx, args) => {
      seen.push({ ...args });
      return { ok: true };
    },
  };
}

function chainOf(steps: readonly StepPlan[]): ChainPlan {
  const kase: CasePlan = { caseId: "case-1", revisionId: "rev-1", expectedToFail: false, steps };
  return { chainKey: "login>checkout", cases: [kase], stepCount: steps.length, timeoutSeconds: 180 };
}

function verb(execute: VerbDefinition["execute"]): VerbDefinition {
  return { opKey: "web.click", sentence: "Click on {element}", params: [], needsRendering: true, execute };
}

function deps(engine: FakeBrowserEngine, execute: VerbDefinition["execute"], over: Partial<RunChainDeps> = {}): RunChainDeps {
  return {
    engine,
    resolveVerb: () => verb(execute),
    now: () => Date.now(),
    onStep: () => {},
    screenshot: async () => null,
    log: () => {},
    ...over,
  };
}

describe("runChain", () => {
  it("passes a chain whose every step returns ok", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1), actionStep(2)]), policy, deps(engine, async () => ({ ok: true })));
    expect(out.verdict).toBe("passed");
    expect(out.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
  });

  it("uses exactly ONE context for the whole chain", async () => {
    const engine = new FakeBrowserEngine();
    await runChain(chainOf([actionStep(1), actionStep(2), actionStep(3)]), policy, deps(engine, async () => ({ ok: true })));
    expect(engine.contextsServed()).toBe(1);
  });

  it("closes the context in finally even when a step throws", async () => {
    const engine = new FakeBrowserEngine();
    await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => { throw new Error("kaboom"); }));
    expect(engine.openContextIds.size).toBe(0);
  });

  /**
   * The chain budget must be a REAL one — 180s, the compiler's floor — not the `timeoutSeconds: 0`
   * this test used to pass, which only expired instantly because `assertNested` was clamping the
   * value away instead of refusing it. Four steps of 50s each overrun a 180s chain while every
   * step stays inside its own 60s budget, which is the only shape a chain deadline can actually
   * fire in once the layers are genuinely nested. Fake timers keep it instant.
   */
  it("closes the context in finally even when the chain times out", async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeBrowserEngine();
      const slow = chainOf([actionStep(1), actionStep(2), actionStep(3), actionStep(4)]);
      const running = runChain({ ...slow, timeoutSeconds: 180 }, policy, deps(engine, async () => {
        await new Promise((r) => setTimeout(r, 50_000));
        return { ok: true };
      }));
      await vi.advanceTimersByTimeAsync(200_000);
      const out = await running;
      expect(engine.openContextIds.size).toBe(0);
      expect(out.verdict).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The guard exists for exactly one shape — a plan whose chain budget is SHORTER than the step
   * budget nested inside it — and the clamp in the call made it a no-op for that shape: the
   * assertion saw `stepMs + 1` while the engine and the chain deadline were handed the real,
   * un-nested number. A plan like this can only come from a compiler that disagrees with the
   * runner about the timeout ladder, and it must fail loudly, before a browser is opened.
   */
  it("refuses a chain budget shorter than one step instead of clamping it out of sight", async () => {
    const engine = new FakeBrowserEngine();
    await expect(
      runChain({ ...chainOf([actionStep(1)]), timeoutSeconds: 30 }, policy, deps(engine, async () => ({ ok: true }))),
    ).rejects.toThrow(/timeout nesting broken: step 60000ms >= chain 30000ms/);
    expect(engine.contextsServed()).toBe(0);
  });

  it("turns an ok=false OpResult into verdict=failed and stops the chain", async () => {
    const engine = new FakeBrowserEngine();
    const execute = vi.fn(async () => ({ ok: false, failureMessage: "button not found" }));
    const out = await runChain(chainOf([actionStep(1), actionStep(2)]), policy, deps(engine, execute));
    expect(out.verdict).toBe("failed");
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]?.message).toContain("button not found");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown AssertionFailure into verdict=failed, NEVER infra_error", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => { throw new AssertionFailure("text mismatch"); }));
    expect(out.verdict).toBe("failed");
    expect(out.infra).toBeUndefined();
  });

  it("reports a RetryableInfraError as infra_error, not as a verdict", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => { throw new RetryableInfraError("browser_oom", "killed"); }));
    expect(out.verdict).toBe("infra_error");
    expect(out.infra).toMatchObject({ code: "browser_oom", retryable: true });
  });

  it("reports a failure to create the context as infra_error and never as failed", async () => {
    const engine = new FakeBrowserEngine();
    engine.failNextContext(new RetryableInfraError("context_crash", "no context"));
    const out = await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => ({ ok: true })));
    expect(out.verdict).toBe("infra_error");
    expect(out.infra?.code).toBe("context_crash");
  });

  it("fails fatally when a step's opKey is not in the registry", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1, "web.nope")]), policy, {
      ...deps(engine, async () => ({ ok: true })),
      resolveVerb: () => undefined,
    });
    expect(out.verdict).toBe("infra_error");
    expect(out.infra).toMatchObject({ retryable: false });
    expect(out.infra?.message).toContain("web.nope");
  });

  it("runs a for-block once per loop row from the frozen plan", async () => {
    const engine = new FakeBrowserEngine();
    const forStep: StepPlan = {
      kind: "for", ordinal: 1, renderedSentence: "For each row", groupPath: [], args: {},
      children: [actionStep(2)],
      loopRows: [
        { label: "row-a", expectedToFail: false, values: { user: "a" } },
        { label: "row-b", expectedToFail: false, values: { user: "b" } },
        { label: "row-c", expectedToFail: false, values: { user: "c" } },
      ],
    };
    const execute = vi.fn(async () => ({ ok: true }));
    const out = await runChain(chainOf([forStep]), policy, deps(engine, execute));
    expect(out.verdict).toBe("passed");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("binds the CURRENT loop row into a for-body step's $data args", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    const chain = chainOf([
      forStep(1, [row("a", { user: "ann" }), row("b", { user: "bob" }), row("c", { user: "cat" })], [
        argsStep(2, { element: "btn", user: "$data:user" }),
      ]),
    ]);
    const out = await runChain(chain, policy, deps(engine, rec.execute));
    expect(out.verdict).toBe("passed");
    expect(rec.seen).toEqual([
      { element: "btn", user: "ann" },
      { element: "btn", user: "bob" },
      { element: "btn", user: "cat" },
    ]);
  });

  it("keeps a $data ref the loop row has no column for, exactly as the compiler does", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    const chain = chainOf([forStep(1, [row("a", { user: "ann" })], [argsStep(2, { who: "$data:absent" })])]);
    await runChain(chain, policy, deps(engine, rec.execute));
    expect(rec.seen).toEqual([{ who: "$data:absent" }]);
  });

  it("never lets loop data reach a $secret ref, and never re-reads a substituted value", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    const chain = chainOf([
      forStep(1, [row("a", { pw: "leaked", user: "$secret:pw" })], [
        argsStep(2, { pw: "$secret:pw", user: "$data:user" }),
      ]),
    ]);
    await runChain(chain, policy, deps(engine, rec.execute));
    // "$secret:pw" is untouched, and the value substituted for $data:user is NOT rescanned as a ref.
    expect(rec.seen).toEqual([{ pw: "$secret:pw", user: "$secret:pw" }]);
  });

  it("substitutes a whole-string ref only, never a ref embedded in a longer string", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    const chain = chainOf([forStep(1, [row("a", { user: "ann" })], [argsStep(2, { greet: "hello $data:user" })])]);
    await runChain(chain, policy, deps(engine, rec.execute));
    expect(rec.seen).toEqual([{ greet: "hello $data:user" }]);
  });

  it("lets an inner loop row shadow the outer one column by column", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    const inner = forStep(2, [row("x", { user: "x" }), row("y", { user: "y" })], [
      argsStep(3, { user: "$data:user", tenant: "$data:tenant" }),
    ]);
    const chain = chainOf([forStep(1, [row("outer", { user: "outer", tenant: "acme" })], [inner])]);
    await runChain(chain, policy, deps(engine, rec.execute));
    expect(rec.seen).toEqual([
      { user: "x", tenant: "acme" },
      { user: "y", tenant: "acme" },
    ]);
  });

  it("leaves a $data ref outside any for body alone — the compiler already merged the case row", async () => {
    const engine = new FakeBrowserEngine();
    const rec = recorder();
    await runChain(chainOf([argsStep(1, { user: "$data:user" })]), policy, deps(engine, rec.execute));
    expect(rec.seen).toEqual([{ user: "$data:user" }]);
  });

  it("refuses an if/while/rest step with a NAMED fatal error (the explicit M4 boundary)", async () => {
    const engine = new FakeBrowserEngine();
    const ifStep: StepPlan = { kind: "if", ordinal: 1, renderedSentence: "If visible", groupPath: [], args: {}, children: [actionStep(2)] };
    const out = await runChain(chainOf([ifStep]), policy, deps(engine, async () => ({ ok: true })));
    expect(out.verdict).toBe("infra_error");
    expect(out.infra?.message).toContain("if");
    expect(out.infra?.retryable).toBe(false);
  });

  it("emits a step event for every finished step so progress is reportable live", async () => {
    const engine = new FakeBrowserEngine();
    const onStep = vi.fn();
    await runChain(chainOf([actionStep(1), actionStep(2)]), policy, deps(engine, async () => ({ ok: true }), { onStep }));
    expect(onStep).toHaveBeenCalledTimes(2);
  });

  /**
   * REGRESSION, found by the 200-chain acceptance soak on 2026-08-31 (`test/soak`). Every step
   * and the chain itself race their work against a deadline; the loser's timer used to be left
   * pending. A pending timer holds its callback closure, and that closure reaches — through the
   * reject function, the raced promise and the frames awaiting it — the executor's deps, the
   * worker's `onStep` closure, the ClaimedJob and finally the whole frozen RunPlan. The heap
   * snapshot diff was unambiguous: ONE fully parsed RunPlan retained per chain, ~0.5MB per chain
   * of node RSS, released only when each timer eventually fired (up to 180s later). `unref()`
   * does not help — it stops a timer from holding the event loop OPEN, not from holding memory.
   */
  it("leaves no timer pending: a lost race timer retains the whole job graph until it fires", async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeBrowserEngine();
      const before = vi.getTimerCount();
      const out = await runChain(
        chainOf([actionStep(1), actionStep(2), actionStep(3)]),
        policy,
        deps(engine, async () => ({ ok: true })),
      );
      expect(out.verdict).toBe("passed");
      // Three step deadlines plus the chain deadline, all of them cleared.
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches the screenshot hash the artifact layer returned", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => ({ ok: true }), {
      screenshot: async () => "abc123",
    }));
    expect(out.steps[0]?.screenshotSha256).toBe("abc123");
  });
});
