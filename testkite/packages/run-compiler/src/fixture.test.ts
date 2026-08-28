import { describe, expect, it } from "vitest";
import { parseFixture } from "./fixture.js";
import { COMPILE_ERROR_CODES } from "./index.js";

/**
 * A golden fixture is DATA (JSON on disk), not code — so TypeScript can't check it. This
 * parser is what stands guard in TypeScript's place: a mistyped key (`verbOpkey`) slipping
 * through would SILENTLY turn a "verb is valid" fixture into an "unknown_verb" fixture, and
 * golden would then stamp that mistake as the contract. So the parser REJECTS unknown keys
 * instead of skipping them.
 */

/** A minimal valid fixture — each test only changes the part it's actually checking. */
function rawFixture(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    name: "minimal",
    description: "một case, một step click",
    expect: "plan",
    snapshot: {
      teamId: "t1",
      projectId: "p1",
      targetCaseIds: ["c1"],
      cases: {
        c1: {
          id: "c1",
          revisionId: "rev-c1",
          name: "case 1",
          isStepGroup: false,
          steps: [
            {
              ordinal: 1,
              kind: "action",
              verbOpKey: "web.click",
              args: {},
              elementId: "el-1",
              renderedSentence: "Click on el-1",
            },
          ],
        },
      },
      elements: {
        "el-1": {
          id: "el-1",
          name: "el-1",
          status: "ready",
          locators: [{ kind: "css", value: "#el-1" }],
        },
      },
      dataProfiles: {},
      env: { baseUrl: "https://app.example", vars: {}, secretNames: [] },
    },
    ...overrides,
  };
}

/** Replaces case c1's first step (where every step-structure test pokes in). */
function withFirstStep(step: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const base = rawFixture();
  const snapshot = base["snapshot"];
  if (typeof snapshot !== "object" || snapshot === null) throw new Error("sample fixture is broken");
  const cases = { c1: { ...caseOf(base), steps: [step] } };
  return { ...base, snapshot: { ...snapshot, cases } };
}

function caseOf(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const snapshot = raw["snapshot"];
  if (typeof snapshot !== "object" || snapshot === null) throw new Error("sample fixture is broken");
  const cases = (snapshot as Readonly<Record<string, unknown>>)["cases"];
  if (typeof cases !== "object" || cases === null) throw new Error("sample fixture is broken");
  const c1 = (cases as Readonly<Record<string, unknown>>)["c1"];
  if (typeof c1 !== "object" || c1 === null) throw new Error("sample fixture is broken");
  return c1 as Readonly<Record<string, unknown>>;
}

describe("parseFixture — valid shape", () => {
  it("builds a CompileInput from raw JSON", () => {
    const fixture = parseFixture(rawFixture(), "minimal.json");

    expect(fixture.name).toBe("minimal");
    expect(fixture.description).toBe("một case, một step click");
    expect(fixture.expect).toBe("plan");
    expect(fixture.expectCodes).toEqual([]);
    expect(fixture.input.snapshot.targetCaseIds).toEqual(["c1"]);
    expect(fixture.input.snapshot.cases["c1"]?.steps[0]?.verbOpKey).toBe("web.click");
    expect(fixture.input.snapshot.elements["el-1"]?.locators).toEqual([{ kind: "css", value: "#el-1" }]);
  });

  it("lane/screenshots absent ⇒ NO key in CompileInput (exactOptionalPropertyTypes)", () => {
    const fixture = parseFixture(rawFixture(), "minimal.json");

    expect("lane" in fixture.input).toBe(false);
    expect("screenshots" in fixture.input).toBe(false);
  });

  it("lane/screenshots present ⇒ pass straight through to CompileInput", () => {
    const fixture = parseFixture(
      rawFixture({ lane: "interactive", screenshots: "none" }),
      "lane.json",
    );

    expect(fixture.input.lane).toBe("interactive");
    expect(fixture.input.screenshots).toBe("none");
  });

  it("recursively parses a structural node's children", () => {
    const fixture = parseFixture(
      withFirstStep({
        ordinal: 1,
        kind: "if",
        conditionExpected: ["SUCCESS"],
        renderedSentence: "if #1",
        children: [
          {
            ordinal: 1,
            kind: "for",
            loopDataProfileId: "p-rows",
            renderedSentence: "for #1",
            children: [{ ordinal: 1, kind: "action", verbOpKey: "web.click", renderedSentence: "click" }],
          },
        ],
      }),
      "nested.json",
    );

    const root = fixture.input.snapshot.cases["c1"]?.steps[0];
    expect(root?.kind).toBe("if");
    expect(root?.conditionExpected).toEqual(["SUCCESS"]);
    const inner = root?.children?.[0];
    expect(inner?.kind).toBe("for");
    expect(inner?.loopDataProfileId).toBe("p-rows");
    expect(inner?.children?.[0]?.verbOpKey).toBe("web.click");
  });

  it("a negative fixture carries expectCodes that are real CompileErrorCodes", () => {
    const fixture = parseFixture(
      rawFixture({ expect: "diagnostics", expectCodes: ["unknown_verb", "element_not_found"] }),
      "neg.json",
    );

    expect(fixture.expect).toBe("diagnostics");
    expect(fixture.expectCodes).toEqual(["unknown_verb", "element_not_found"]);
  });
});

describe("parseFixture — rejects a broken fixture", () => {
  it("an unknown top-level key (a typo) is rejected with the file name", () => {
    expect(() => parseFixture({ ...rawFixture(), snapshto: {} }, "typo.json")).toThrow(
      /typo\.json.*snapshto/s,
    );
  });

  it("an unknown key in a step is rejected — this is exactly the silent bug that must be blocked", () => {
    expect(() =>
      parseFixture(
        withFirstStep({ ordinal: 1, kind: "action", verbOpkey: "web.click", renderedSentence: "x" }),
        "typo-step.json",
      ),
    ).toThrow(/verbOpkey/);
  });

  it("a missing required field is rejected with its path", () => {
    expect(() =>
      parseFixture(withFirstStep({ kind: "action", renderedSentence: "x" }), "missing.json"),
    ).toThrow(/cases\.c1\.steps\[0\]\.ordinal/);
  });

  it("a wrong type is rejected with its path", () => {
    expect(() =>
      parseFixture(
        withFirstStep({ ordinal: "1", kind: "action", renderedSentence: "x" }),
        "wrong-type.json",
      ),
    ).toThrow(/steps\[0\]\.ordinal.*number/s);
  });

  it("an unknown kind is rejected", () => {
    expect(() =>
      parseFixture(withFirstStep({ ordinal: 1, kind: "swipe", renderedSentence: "x" }), "kind.json"),
    ).toThrow(/kind.*swipe/s);
  });

  it("a record's key differing from its internal id ⇒ rejected (a record is indexed by id)", () => {
    const base = rawFixture();
    const snapshot = base["snapshot"];
    if (typeof snapshot !== "object" || snapshot === null) throw new Error("sample fixture is broken");

    expect(() =>
      parseFixture(
        { ...base, snapshot: { ...snapshot, cases: { "c-other": caseOf(base) } } },
        "key.json",
      ),
    ).toThrow(/c-other.*c1/s);
  });

  it("expectCodes containing a code not in CompileErrorCode ⇒ rejected", () => {
    expect(() =>
      parseFixture(
        rawFixture({ expect: "diagnostics", expectCodes: ["verb_args_invalidd"] }),
        "code.json",
      ),
    ).toThrow(/verb_args_invalidd/);
  });

  it("expect=plan while declaring expectCodes ⇒ rejected (a self-contradictory fixture)", () => {
    expect(() => parseFixture(rawFixture({ expectCodes: ["unknown_verb"] }), "mix.json")).toThrow(
      /expect/,
    );
  });

  it("expect=diagnostics with empty expectCodes ⇒ rejected (a negative fixture must say why it's negative)", () => {
    expect(() => parseFixture(rawFixture({ expect: "diagnostics" }), "empty.json")).toThrow(
      /expectCodes/,
    );
  });

  it("JSON that isn't an object ⇒ rejected", () => {
    expect(() => parseFixture([], "arr.json")).toThrow(/arr\.json/);
    expect(() => parseFixture(null, "null.json")).toThrow(/null\.json/);
  });
});

describe("COMPILE_ERROR_CODES", () => {
  it("lists all 12 codes, no duplicates", () => {
    expect(COMPILE_ERROR_CODES).toHaveLength(12);
    expect(new Set(COMPILE_ERROR_CODES).size).toBe(COMPILE_ERROR_CODES.length);
  });

  it("contains codes from all 7 phases", () => {
    expect(COMPILE_ERROR_CODES).toContain("prereq_cycle");
    expect(COMPILE_ERROR_CODES).toContain("step_group_depth_exceeded");
    expect(COMPILE_ERROR_CODES).toContain("unknown_verb");
    expect(COMPILE_ERROR_CODES).toContain("element_pending_locator");
    expect(COMPILE_ERROR_CODES).toContain("secret_ref_unknown");
    expect(COMPILE_ERROR_CODES).toContain("data_profile_empty");
  });
});
