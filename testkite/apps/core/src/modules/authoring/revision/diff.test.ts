import { describe, expect, it } from "vitest";
import type { RevisionPayload, RevisionStep } from "./payload.js";
import { diffFlat, flattenRevision, threeWayDiff } from "./diff.js";

function step(id: string, after: string | null, sentence: string): RevisionStep {
  return {
    id,
    kind: "action",
    parentId: null,
    after,
    renderedSentence: sentence,
    verbOpKey: "click",
  };
}

const BASE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

/** Chèn s9 vào giữa: chỉ s2 đổi `after`, không step nào khác động đậy. */
const MINE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s9", "s1", "accept cookie banner"),
    step("s2", "s9", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

const THEIRS: RevisionPayload = {
  case: { name: "Checkout v2", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click the submit button"),
  ],
};

describe("flattenRevision", () => {
  it("gom scalar của case và bản đồ field theo id step", () => {
    const f = flattenRevision(BASE);
    expect(f.scalars.get("/name")).toBe('"Checkout"');
    expect(f.steps.size).toBe(4);
    expect(f.steps.get("s2")?.get("after")).toBe('"s1"');
    expect(f.steps.get("s1")?.get("after")).toBe("null");
  });

  it("KHÔNG đưa ordinal vào bản phẳng — vị trí chỉ tồn tại dưới dạng `after`", () => {
    const f = flattenRevision(BASE);
    for (const fields of f.steps.values()) expect(fields.has("ordinal")).toBe(false);
  });
});

describe("diffFlat — nhiễu bằng 0 khi chèn step", () => {
  it("chèn ĐÚNG 1 step sinh ĐÚNG 2 mục (spike: thư viện ngoài sinh 4)", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect(d).toEqual([
      { path: "/steps/s2/after", kind: "modified", base: "s1", value: "s9" },
      { path: "/steps/s9", kind: "added", value: MINE.steps[1] },
    ]);
  });

  it("sửa tên case + câu của 1 step sinh đúng 2 mục", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(THEIRS));
    expect(d.map((c) => c.path)).toEqual(["/name", "/steps/s4/renderedSentence"]);
    expect(d.every((c) => c.kind === "modified")).toBe(true);
  });

  it("xoá step báo removed ở CẤP STEP, không vỡ thành từng field", () => {
    const shorter: RevisionPayload = {
      case: BASE.case,
      steps: [step("s1", null, "open login page"), step("s3", "s1", "type password"), step("s4", "s3", "click submit")],
    };
    const d = diffFlat(flattenRevision(BASE), flattenRevision(shorter));
    expect(d.filter((c) => c.kind === "removed").map((c) => c.path)).toEqual(["/steps/s2"]);
  });

  it("payload y hệt ⇒ diff rỗng", () => {
    expect(diffFlat(flattenRevision(BASE), flattenRevision(BASE))).toEqual([]);
  });

  it("kết quả sắp theo path — body 409 ổn định giữa hai lần chạy", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect([...d].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(d);
  });
});

describe("threeWayDiff", () => {
  const meta = { baseVersion: 7, baseRevisionId: "r7", currentVersion: 9, currentRevisionId: "r9" };

  it("hai bên sửa chỗ khác nhau ⇒ conflicts rỗng", () => {
    const r = threeWayDiff({ base: BASE, mine: MINE, theirs: THEIRS, ...meta });
    expect(r.mine).toHaveLength(2);
    expect(r.theirs).toHaveLength(2);
    expect(r.conflicts).toEqual([]);
    expect(r.baseVersion).toBe(7);
    expect(r.currentRevisionId).toBe("r9");
  });

  it("hai bên cùng sửa MỘT field ⇒ path đó nằm trong conflicts", () => {
    const mine2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const theirs2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "press the submit control")],
    };
    const r = threeWayDiff({ base: BASE, mine: mine2, theirs: theirs2, ...meta });
    expect(r.conflicts).toEqual(["/steps/s4/renderedSentence"]);
  });

  it("hai bên sửa GIỐNG HỆT nhau ⇒ KHÔNG phải conflict (cùng đích đến)", () => {
    const same: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: same, theirs: same, ...meta });
    expect(r.conflicts).toEqual([]);
  });

  it("xoá ở một bên và sửa ở bên kia CÙNG step ⇒ conflict ở cấp step", () => {
    const deleted: RevisionPayload = { case: BASE.case, steps: [...BASE.steps.slice(0, 3)] };
    const edited: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: deleted, theirs: edited, ...meta });
    expect(r.conflicts).toContain("/steps/s4");
  });
});
