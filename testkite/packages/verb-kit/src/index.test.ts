import { describe, expect, it } from "vitest";
import { allVerbs, getVerb, registerVerb, validateArgs } from "./index.js";

describe("verb-kit — registry (old API unchanged)", () => {
  it("getVerb returns the registered verb, allVerbs lists them all", () => {
    expect(getVerb("web.click")?.sentence).toBe("Click on {element}");
    expect(allVerbs().map((v) => v.opKey)).toEqual(expect.arrayContaining(["web.click", "web.enter"]));
  });

  it("unknown opKey ⇒ getVerb undefined", () => {
    expect(getVerb("web.telepathy")).toBeUndefined();
  });
});

describe("verb-kit — validateArgs", () => {
  it("web.click with element ⇒ ok", () => {
    expect(validateArgs("web.click", { element: "el-login" })).toEqual({ ok: true });
  });

  it("web.click missing element ⇒ ok:false, issue names the param", () => {
    const r = validateArgs("web.click", {});

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.issues).toEqual(["element: Required"]);
  });

  it("web.enter with element + value ⇒ ok", () => {
    expect(validateArgs("web.enter", { element: "el-user", value: "admin" })).toEqual({ ok: true });
  });

  it("web.enter missing value ⇒ ok:false", () => {
    const r = validateArgs("web.enter", { element: "el-user" });

    expect(r.ok === false && r.issues).toEqual(["value: Required"]);
  });

  it("COLLECTS: web.enter missing both params ⇒ 2 issues (no first-fail)", () => {
    const r = validateArgs("web.enter", {});

    expect(r.ok === false && r.issues).toHaveLength(2);
  });

  it("empty value ⇒ ok:false (an empty string isn't data)", () => {
    const r = validateArgs("web.enter", { element: "el-user", value: "" });

    expect(r.ok).toBe(false);
  });

  it("extra arg ⇒ still ok (schema strips, not strict)", () => {
    expect(validateArgs("web.click", { element: "el-login", waitMs: "500" })).toEqual({ ok: true });
  });

  it("unknown opKey ⇒ ok:false with an issue naming the opKey", () => {
    const r = validateArgs("web.telepathy", {});

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.issues.join()).toContain("web.telepathy");
  });

  it("a verb with no argsSchema yet ⇒ ok (doesn't break verbs registered under the old API)", () => {
    registerVerb({
      opKey: "test.legacy-no-schema",
      sentence: "Legacy {raw}",
      params: [{ name: "raw", kind: "raw", required: true }],
      needsRendering: false,
      execute: async () => ({ ok: true }),
    });

    expect(validateArgs("test.legacy-no-schema", {})).toEqual({ ok: true });
  });

  it("invariant: for a verb with an argsSchema, EVERY required param is caught by the schema when missing", () => {
    for (const verb of allVerbs()) {
      if (verb.argsSchema === undefined) continue;
      const r = validateArgs(verb.opKey, {});
      const reported = r.ok === false ? r.issues.join(" | ") : "";
      for (const param of verb.params.filter((p) => p.required)) {
        expect(reported, `${verb.opKey} / ${param.name}`).toContain(param.name);
      }
    }
  });
});
