/**
 * HONESTY NOTE — what these tests do and do not prove.
 *
 * Every test in this file runs on `FakeBrowserEngine`. What is proved here is the executor's
 * ORCHESTRATION LOGIC and nothing else: that exactly one context is requested per chain, that
 * the context is closed on every exit path, that a step result / thrown value is mapped onto
 * the right verdict, that a `for` body runs once per frozen loop row, and that an unsupported
 * step kind is refused by name.
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
import type { CasePlan, ChainPlan, RunPolicy, StepPlan } from "@testkite/run-compiler";
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

  it("closes the context in finally even when the chain times out", async () => {
    const engine = new FakeBrowserEngine();
    const slow = chainOf([actionStep(1)]);
    const out = await runChain({ ...slow, timeoutSeconds: 0 }, policy, deps(engine, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true };
    }));
    expect(engine.openContextIds.size).toBe(0);
    expect(out.verdict).toBe("failed");
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

  it("attaches the screenshot hash the artifact layer returned", async () => {
    const engine = new FakeBrowserEngine();
    const out = await runChain(chainOf([actionStep(1)]), policy, deps(engine, async () => ({ ok: true }), {
      screenshot: async () => "abc123",
    }));
    expect(out.steps[0]?.screenshotSha256).toBe("abc123");
  });
});
