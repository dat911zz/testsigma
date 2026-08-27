import { describe, expect, it } from "vitest";
import { parseFixture } from "./fixture.js";
import { COMPILE_ERROR_CODES } from "./index.js";

/**
 * Fixture golden là DỮ LIỆU (JSON trên đĩa), không phải code — nên nó không được TypeScript
 * kiểm. Parser này là thứ thay TypeScript đứng gác: một khoá gõ sai (`verbOpkey`) mà lọt qua
 * sẽ biến fixture "verb hợp lệ" thành fixture "unknown_verb" một cách IM LẶNG, rồi golden
 * đóng dấu cái sai đó thành hợp đồng. Vì vậy parser TỪ CHỐI khoá lạ thay vì bỏ qua.
 */

/** Fixture hợp lệ tối thiểu — mỗi test chỉ đổi đúng phần nó đang kiểm. */
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

/** Đổi step đầu tiên của case c1 (nơi mọi test cấu trúc step chọc vào). */
function withFirstStep(step: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const base = rawFixture();
  const snapshot = base["snapshot"];
  if (typeof snapshot !== "object" || snapshot === null) throw new Error("fixture mẫu hỏng");
  const cases = { c1: { ...caseOf(base), steps: [step] } };
  return { ...base, snapshot: { ...snapshot, cases } };
}

function caseOf(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const snapshot = raw["snapshot"];
  if (typeof snapshot !== "object" || snapshot === null) throw new Error("fixture mẫu hỏng");
  const cases = (snapshot as Readonly<Record<string, unknown>>)["cases"];
  if (typeof cases !== "object" || cases === null) throw new Error("fixture mẫu hỏng");
  const c1 = (cases as Readonly<Record<string, unknown>>)["c1"];
  if (typeof c1 !== "object" || c1 === null) throw new Error("fixture mẫu hỏng");
  return c1 as Readonly<Record<string, unknown>>;
}

describe("parseFixture — hình dạng hợp lệ", () => {
  it("dựng CompileInput từ JSON thô", () => {
    const fixture = parseFixture(rawFixture(), "minimal.json");

    expect(fixture.name).toBe("minimal");
    expect(fixture.description).toBe("một case, một step click");
    expect(fixture.expect).toBe("plan");
    expect(fixture.expectCodes).toEqual([]);
    expect(fixture.input.snapshot.targetCaseIds).toEqual(["c1"]);
    expect(fixture.input.snapshot.cases["c1"]?.steps[0]?.verbOpKey).toBe("web.click");
    expect(fixture.input.snapshot.elements["el-1"]?.locators).toEqual([{ kind: "css", value: "#el-1" }]);
  });

  it("lane/screenshots vắng mặt ⇒ KHÔNG có key trong CompileInput (exactOptionalPropertyTypes)", () => {
    const fixture = parseFixture(rawFixture(), "minimal.json");

    expect("lane" in fixture.input).toBe(false);
    expect("screenshots" in fixture.input).toBe(false);
  });

  it("lane/screenshots có mặt ⇒ vào thẳng CompileInput", () => {
    const fixture = parseFixture(
      rawFixture({ lane: "interactive", screenshots: "none" }),
      "lane.json",
    );

    expect(fixture.input.lane).toBe("interactive");
    expect(fixture.input.screenshots).toBe("none");
  });

  it("parse đệ quy children của node cấu trúc", () => {
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

  it("fixture âm mang expectCodes là CompileErrorCode thật", () => {
    const fixture = parseFixture(
      rawFixture({ expect: "diagnostics", expectCodes: ["unknown_verb", "element_not_found"] }),
      "neg.json",
    );

    expect(fixture.expect).toBe("diagnostics");
    expect(fixture.expectCodes).toEqual(["unknown_verb", "element_not_found"]);
  });
});

describe("parseFixture — từ chối fixture hỏng", () => {
  it("khoá lạ ở top-level (gõ sai tên) bị từ chối kèm tên file", () => {
    expect(() => parseFixture({ ...rawFixture(), snapshto: {} }, "typo.json")).toThrow(
      /typo\.json.*snapshto/s,
    );
  });

  it("khoá lạ trong step bị từ chối — đây chính là lỗi im lặng cần chặn", () => {
    expect(() =>
      parseFixture(
        withFirstStep({ ordinal: 1, kind: "action", verbOpkey: "web.click", renderedSentence: "x" }),
        "typo-step.json",
      ),
    ).toThrow(/verbOpkey/);
  });

  it("thiếu field bắt buộc bị từ chối kèm đường dẫn", () => {
    expect(() =>
      parseFixture(withFirstStep({ kind: "action", renderedSentence: "x" }), "missing.json"),
    ).toThrow(/cases\.c1\.steps\[0\]\.ordinal/);
  });

  it("sai kiểu bị từ chối kèm đường dẫn", () => {
    expect(() =>
      parseFixture(
        withFirstStep({ ordinal: "1", kind: "action", renderedSentence: "x" }),
        "wrong-type.json",
      ),
    ).toThrow(/steps\[0\]\.ordinal.*number/s);
  });

  it("kind lạ bị từ chối", () => {
    expect(() =>
      parseFixture(withFirstStep({ ordinal: 1, kind: "swipe", renderedSentence: "x" }), "kind.json"),
    ).toThrow(/kind.*swipe/s);
  });

  it("khoá của record khác id bên trong ⇒ từ chối (record là index theo id)", () => {
    const base = rawFixture();
    const snapshot = base["snapshot"];
    if (typeof snapshot !== "object" || snapshot === null) throw new Error("fixture mẫu hỏng");

    expect(() =>
      parseFixture(
        { ...base, snapshot: { ...snapshot, cases: { "c-other": caseOf(base) } } },
        "key.json",
      ),
    ).toThrow(/c-other.*c1/s);
  });

  it("expectCodes chứa code không có trong CompileErrorCode ⇒ từ chối", () => {
    expect(() =>
      parseFixture(
        rawFixture({ expect: "diagnostics", expectCodes: ["verb_args_invalidd"] }),
        "code.json",
      ),
    ).toThrow(/verb_args_invalidd/);
  });

  it("expect=plan mà khai expectCodes ⇒ từ chối (fixture tự mâu thuẫn)", () => {
    expect(() => parseFixture(rawFixture({ expectCodes: ["unknown_verb"] }), "mix.json")).toThrow(
      /expect/,
    );
  });

  it("expect=diagnostics mà expectCodes rỗng ⇒ từ chối (fixture âm phải nói nó âm vì gì)", () => {
    expect(() => parseFixture(rawFixture({ expect: "diagnostics" }), "empty.json")).toThrow(
      /expectCodes/,
    );
  });

  it("JSON không phải object ⇒ từ chối", () => {
    expect(() => parseFixture([], "arr.json")).toThrow(/arr\.json/);
    expect(() => parseFixture(null, "null.json")).toThrow(/null\.json/);
  });
});

describe("COMPILE_ERROR_CODES", () => {
  it("liệt kê đủ 12 code, không trùng lặp", () => {
    expect(COMPILE_ERROR_CODES).toHaveLength(12);
    expect(new Set(COMPILE_ERROR_CODES).size).toBe(COMPILE_ERROR_CODES.length);
  });

  it("chứa các code của cả 7 phase", () => {
    expect(COMPILE_ERROR_CODES).toContain("prereq_cycle");
    expect(COMPILE_ERROR_CODES).toContain("step_group_depth_exceeded");
    expect(COMPILE_ERROR_CODES).toContain("unknown_verb");
    expect(COMPILE_ERROR_CODES).toContain("element_pending_locator");
    expect(COMPILE_ERROR_CODES).toContain("secret_ref_unknown");
    expect(COMPILE_ERROR_CODES).toContain("data_profile_empty");
  });
});
