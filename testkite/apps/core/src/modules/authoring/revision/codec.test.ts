import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { decodeRevision, encodeRevision, ZSTD_LEVEL } from "./codec.js";

/** Payload case đủ lớn để zstd thắng — cùng hình dạng spike 2026-08-28. */
function bigPayload(n: number): { name: string; steps: { id: string; renderedSentence: string }[] } {
  const steps = [];
  for (let i = 1; i <= n; i++) {
    steps.push({
      id: `s${i}`,
      renderedSentence: `Enter "$secret:std_user_password" into the password field on the login page at step ${i}`,
    });
  }
  return { name: "Checkout — guest user", steps };
}

describe("canonicalJson", () => {
  it("sắp khoá object nên hai object khác thứ tự cho CÙNG chuỗi", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("GIỮ NGUYÊN thứ tự mảng — thứ tự step là dữ liệu, không phải nhiễu", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sắp khoá ĐỆ QUY, kể cả object lồng trong mảng", () => {
    expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });

  it("bỏ prop undefined thay vì ném — payload dựng từ DTO optional", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("từ chối số không hữu hạn — NaN/Infinity làm hash bất định", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/hữu hạn/);
  });
});

describe("encodeRevision", () => {
  it("nén zstd cho payload lớn và giảm ít nhất 5 lần", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.codec).toBe("zstd");
    expect(enc.bytes.length * 5).toBeLessThan(enc.rawSize);
  });

  it("blob mang magic number zstd 28 b5 2f fd", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.bytes.subarray(0, 4).toString("hex")).toBe("28b52ffd");
  });

  it("payload BÉ thì rơi về codec raw — nén làm nó phình ra (spike: 69B -> 78B)", () => {
    const enc = encodeRevision({ id: "x" });
    expect(enc.codec).toBe("raw");
    expect(enc.bytes.length).toBe(enc.rawSize);
  });

  it("rawSize là độ dài JSON canonical, không phải độ dài blob", () => {
    const payload = bigPayload(40);
    const enc = encodeRevision(payload);
    expect(enc.rawSize).toBe(Buffer.byteLength(canonicalJson(payload), "utf8"));
  });

  it("sha256 tính trên JSON canonical nên KHÔNG đổi khi hoán vị khoá", () => {
    const a = encodeRevision({ name: "n", steps: [] });
    const b = encodeRevision({ steps: [], name: "n" });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic: nén hai lần ra ĐÚNG cùng byte (điều kiện của test golden)", () => {
    const p = bigPayload(40);
    expect(encodeRevision(p).bytes.equals(encodeRevision(p).bytes)).toBe(true);
  });

  it("mức nén chốt là 10", () => {
    expect(ZSTD_LEVEL).toBe(10);
  });
});

describe("decodeRevision", () => {
  it("round-trip zstd", () => {
    const p = bigPayload(40);
    const enc = encodeRevision(p);
    expect(decodeRevision(enc.codec, enc.bytes)).toEqual(p);
  });

  it("round-trip raw", () => {
    const enc = encodeRevision({ id: "x" });
    expect(decodeRevision(enc.codec, enc.bytes)).toEqual({ id: "x" });
  });

  it("nhận Uint8Array — PGlite trả bytea về dạng đó, KHÔNG phải Buffer", () => {
    const enc = encodeRevision(bigPayload(40));
    const asU8 = new Uint8Array(enc.bytes);
    expect(asU8 instanceof Buffer).toBe(false);
    expect(decodeRevision("zstd", asU8)).toEqual(bigPayload(40));
  });
});
