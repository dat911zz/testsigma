/**
 * Gate độ phủ: route mới mà quên fixture thì bộ L3 sẽ IM LẶNG bỏ qua nó — đó là
 * kiểu hỏng tệ nhất (xanh giả). Test này biến sự im lặng đó thành CI đỏ.
 *
 * Nó cố ý KHÔNG dựng app/DB: đây là kiểm tra tĩnh trên hợp đồng, chạy trong vài ms và
 * đỏ ngay cả khi harness PGlite hỏng vì lý do khác.
 */
import { describe, expect, it } from "vitest";
import { ROUTES, pathParamNames } from "@testkite/contract";
import { BODY_FIXTURES, EXEMPT, RESOURCE_FIXTURES } from "./fixtures.js";

describe("độ phủ bộ cách ly L3", () => {
  it("mọi path param đều có RESOURCE_FIXTURES (hoặc route được miễn trừ CÓ LÝ DO)", () => {
    const missing: string[] = [];
    for (const r of ROUTES) {
      if (EXEMPT[r.operationId] !== undefined) continue;
      for (const name of pathParamNames(r.path)) {
        if (RESOURCE_FIXTURES[name] === undefined) missing.push(`${r.operationId} -> ${name}`);
      }
    }
    expect(missing, "thêm fixture vào test/isolation/fixtures.ts").toEqual([]);
  });

  it("mọi route CÓ BODY và cần test L3 đều có BODY_FIXTURES", () => {
    const missing = ROUTES.filter(
      (r) =>
        r.body !== undefined &&
        pathParamNames(r.path).length > 0 &&
        EXEMPT[r.operationId] === undefined &&
        BODY_FIXTURES[r.operationId] === undefined,
    ).map((r) => r.operationId);
    // Thiếu body hợp lệ ⇒ route trả 400 và che mất câu hỏi 404-hay-403.
    expect(missing).toEqual([]);
  });

  it("mọi miễn trừ đều có lý do bằng chữ, không phải cờ trống", () => {
    for (const [op, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${op}: lý do quá ngắn`).toBeGreaterThan(30);
      expect(
        ROUTES.some((r) => r.operationId === op),
        `${op} không còn tồn tại — xoá khỏi EXEMPT`,
      ).toBe(true);
    }
  });

  it("miễn trừ chỉ dành cho route CÓ path param — route không có id thì không có gì để miễn", () => {
    // Miễn trừ một route không path param là vô nghĩa (bộ L3 vốn đã không nhắm tới nó)
    // và nguy hiểm: nó dạy người sau rằng EXEMPT là chỗ để làm im tiếng bất kỳ route nào.
    for (const op of Object.keys(EXEMPT)) {
      const r = ROUTES.find((x) => x.operationId === op);
      expect(
        pathParamNames(r?.path ?? "").length,
        `${op} không có path param — bỏ khỏi EXEMPT`,
      ).toBeGreaterThan(0);
    }
  });

  it("fixture không thừa: mọi khoá RESOURCE_FIXTURES đều được ít nhất một route dùng", () => {
    const used = new Set(ROUTES.flatMap((r) => pathParamNames(r.path)));
    for (const key of Object.keys(RESOURCE_FIXTURES)) {
      expect(used.has(key), `fixture "${key}" không route nào dùng — xoá đi`).toBe(true);
    }
  });

  it("body fixture không thừa: mọi khoá BODY_FIXTURES đều trỏ vào một operationId có thật", () => {
    const ops = new Set(ROUTES.map((r) => r.operationId));
    for (const key of Object.keys(BODY_FIXTURES)) {
      expect(ops.has(key), `BODY_FIXTURES["${key}"] không còn route nào — xoá đi`).toBe(true);
    }
  });
});
