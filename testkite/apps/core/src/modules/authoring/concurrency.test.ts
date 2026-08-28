import { describe, expect, it } from "vitest";
import { formatETag, parseIfMatch } from "./concurrency.js";
import { IfMatchRequiredError, VersionConflictError } from "./errors.js";

describe("formatETag", () => {
  it("bọc version trong dấu nháy kép — entity-tag của RFC 9110", () => {
    expect(formatETag(1)).toBe('"1"');
    expect(formatETag(42)).toBe('"42"');
  });
});

describe("parseIfMatch", () => {
  it("đọc được entity-tag có nháy", () => {
    expect(parseIfMatch('"7"')).toBe(7);
  });

  it("chấp nhận dạng trần (client viết tay hay quên nháy)", () => {
    expect(parseIfMatch("7")).toBe(7);
  });

  it("chấp nhận weak tag W/\"7\"", () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it("THIẾU header ⇒ IfMatchRequiredError (HTTP 428)", () => {
    expect(() => parseIfMatch(undefined)).toThrow(IfMatchRequiredError);
    try {
      parseIfMatch(undefined);
    } catch (e) {
      expect((e as IfMatchRequiredError).httpStatus).toBe(428);
      expect((e as IfMatchRequiredError).code).toBe("if_match_required");
    }
  });

  it("header rỗng hoặc toàn khoảng trắng ⇒ 428", () => {
    expect(() => parseIfMatch("")).toThrow(IfMatchRequiredError);
    expect(() => parseIfMatch("   ")).toThrow(IfMatchRequiredError);
  });

  it("`*` bị TỪ CHỐI — nó nghĩa là tắt kiểm tra đồng thời", () => {
    expect(() => parseIfMatch("*")).toThrow(IfMatchRequiredError);
  });

  it("giá trị không phải số nguyên dương ⇒ 428", () => {
    for (const bad of ['"abc"', '"0"', '"-1"', '"1.5"', '"1,2"']) {
      expect(() => parseIfMatch(bad)).toThrow(IfMatchRequiredError);
    }
  });
});

describe("VersionConflictError", () => {
  it("mang nguyên diff 3 chiều để route trả thẳng vào body 409", () => {
    const diff = {
      baseVersion: 7,
      baseRevisionId: "r7",
      currentVersion: 9,
      currentRevisionId: "r9",
      mine: [],
      theirs: [],
      conflicts: [],
    };
    const err = new VersionConflictError(diff);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe("version_conflict");
    expect(err.diff).toBe(diff);
  });
});
