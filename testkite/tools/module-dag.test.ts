/**
 * `module-dag.json` và `ownership.json` mô tả CÙNG bộ 12 module. Thêm module vào
 * một file mà quên file kia = một module không có luật lint nào canh, im lặng
 * suốt đời. Test này biến sự im lặng đó thành đỏ.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Cả hai file đều mang khoá `$comment` làm tài liệu — lọc ra trước mọi so sánh. */
const stripComments = (o: Record<string, unknown>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("$"))) as Record<string, string[]>;

const rawDag = require("../module-dag.json") as Record<string, unknown>;
const dag = Object.fromEntries(
  Object.entries(rawDag).filter(([k]) => !k.startsWith("$")),
) as Record<string, string[]>;
const ownership = stripComments(require("../ownership.json") as Record<string, unknown>);

describe("module-dag.json", () => {
  it("cùng bộ key với ownership.json", () => {
    expect(Object.keys(dag).sort()).toEqual(Object.keys(ownership).sort());
  });

  /**
   * "12 module" là TÊN GỌI trong docs/SYSTEM_DESIGN.md §4, không phải phép đếm:
   * danh sách ngay sau nó liệt kê 13 tên (kernel, identity, governance, verbs,
   * elements, testdata, authoring, planning, orchestration, results + rìa
   * integrations, ai, mcp). `ownership.json` đã commit từ trước cũng đúng 13 khoá.
   * Chốt con số THẬT ở đây làm tripwire: thêm/bớt module là test này đỏ.
   */
  it("đúng 13 module (nhãn '12 module' của §4 là tên gọi, không phải phép đếm)", () => {
    expect(Object.keys(dag)).toHaveLength(13);
  });

  it("mọi đích được phép đều là module có thật", () => {
    const names = new Set(Object.keys(dag));
    for (const [from, allowed] of Object.entries(dag)) {
      for (const to of allowed) expect(names.has(to), `${from} → ${to} không tồn tại`).toBe(true);
    }
  });

  it("không module nào tự import chính mình trong danh sách allow", () => {
    for (const [from, allowed] of Object.entries(dag)) expect(allowed).not.toContain(from);
  });

  it("là DAG THẬT — quan hệ allow không có chu trình", () => {
    // Chu trình tồn tại khi có cặp A allow B và B allow A (hoặc dài hơn).
    const reach = new Map<string, Set<string>>();
    const walk = (n: string, seen: Set<string>): Set<string> => {
      const cached = reach.get(n);
      if (cached !== undefined) return cached;
      const out = new Set<string>();
      for (const next of dag[n] ?? []) {
        expect(seen.has(next), `chu trình qua ${n} → ${next}`).toBe(false);
        out.add(next);
        for (const deep of walk(next, new Set([...seen, next]))) out.add(deep);
      }
      reach.set(n, out);
      return out;
    };
    for (const n of Object.keys(dag)) walk(n, new Set([n]));
  });

  it("kernel là gốc — không được phép import module nào", () => {
    expect(dag["kernel"]).toEqual([]);
  });

  it("module rìa không bao giờ là đích của module lõi", () => {
    const edge = ["integrations", "ai", "mcp-gateway"];
    for (const [from, allowed] of Object.entries(dag)) {
      if (edge.includes(from)) continue;
      for (const e of edge) expect(allowed, `${from} không được import ${e}`).not.toContain(e);
    }
  });
});
