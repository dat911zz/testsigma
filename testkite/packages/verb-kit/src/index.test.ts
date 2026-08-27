import { describe, expect, it } from "vitest";
import { allVerbs, getVerb, registerVerb, validateArgs } from "./index.js";

describe("verb-kit — registry (API cũ không đổi)", () => {
  it("getVerb trả về verb đã đăng ký, allVerbs liệt kê đủ", () => {
    expect(getVerb("web.click")?.sentence).toBe("Click on {element}");
    expect(allVerbs().map((v) => v.opKey)).toEqual(expect.arrayContaining(["web.click", "web.enter"]));
  });

  it("opKey lạ ⇒ getVerb undefined", () => {
    expect(getVerb("web.telepathy")).toBeUndefined();
  });
});

describe("verb-kit — validateArgs", () => {
  it("web.click đủ element ⇒ ok", () => {
    expect(validateArgs("web.click", { element: "el-login" })).toEqual({ ok: true });
  });

  it("web.click thiếu element ⇒ ok:false, issue chỉ mặt param", () => {
    const r = validateArgs("web.click", {});

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.issues).toEqual(["element: Required"]);
  });

  it("web.enter đủ element + value ⇒ ok", () => {
    expect(validateArgs("web.enter", { element: "el-user", value: "admin" })).toEqual({ ok: true });
  });

  it("web.enter thiếu value ⇒ ok:false", () => {
    const r = validateArgs("web.enter", { element: "el-user" });

    expect(r.ok === false && r.issues).toEqual(["value: Required"]);
  });

  it("GOM: web.enter thiếu cả 2 param ⇒ 2 issues (không first-fail)", () => {
    const r = validateArgs("web.enter", {});

    expect(r.ok === false && r.issues).toHaveLength(2);
  });

  it("value rỗng ⇒ ok:false (chuỗi rỗng không phải dữ liệu)", () => {
    const r = validateArgs("web.enter", { element: "el-user", value: "" });

    expect(r.ok).toBe(false);
  });

  it("arg thừa ⇒ vẫn ok (schema strip, không strict)", () => {
    expect(validateArgs("web.click", { element: "el-login", waitMs: "500" })).toEqual({ ok: true });
  });

  it("opKey lạ ⇒ ok:false kèm issue nêu opKey", () => {
    const r = validateArgs("web.telepathy", {});

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.issues.join()).toContain("web.telepathy");
  });

  it("verb chưa khai báo argsSchema ⇒ ok (không phá verb đã đăng ký theo API cũ)", () => {
    registerVerb({
      opKey: "test.legacy-no-schema",
      sentence: "Legacy {raw}",
      params: [{ name: "raw", kind: "raw", required: true }],
      needsRendering: false,
      execute: async () => ({ ok: true }),
    });

    expect(validateArgs("test.legacy-no-schema", {})).toEqual({ ok: true });
  });

  it("bất biến: verb có argsSchema thì MỌI param required đều bị schema bắt lỗi khi thiếu", () => {
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
