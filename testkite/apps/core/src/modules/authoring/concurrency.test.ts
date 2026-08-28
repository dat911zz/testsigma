import { describe, expect, it } from "vitest";
import { formatETag, parseIfMatch } from "./concurrency.js";
import { IfMatchRequiredError, VersionConflictError } from "./errors.js";

describe("formatETag", () => {
  it("wraps the version in double quotes — the RFC 9110 entity-tag", () => {
    expect(formatETag(1)).toBe('"1"');
    expect(formatETag(42)).toBe('"42"');
  });
});

describe("parseIfMatch", () => {
  it("parses a quoted entity-tag", () => {
    expect(parseIfMatch('"7"')).toBe(7);
  });

  it("accepts the bare form (a hand-written client forgetting the quotes)", () => {
    expect(parseIfMatch("7")).toBe(7);
  });

  it("accepts a weak tag W/\"7\"", () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it("MISSING header ⇒ IfMatchRequiredError (HTTP 428)", () => {
    expect(() => parseIfMatch(undefined)).toThrow(IfMatchRequiredError);
    try {
      parseIfMatch(undefined);
    } catch (e) {
      expect((e as IfMatchRequiredError).httpStatus).toBe(428);
      expect((e as IfMatchRequiredError).code).toBe("IF_MATCH_REQUIRED");
    }
  });

  it("empty header or whitespace-only ⇒ 428", () => {
    expect(() => parseIfMatch("")).toThrow(IfMatchRequiredError);
    expect(() => parseIfMatch("   ")).toThrow(IfMatchRequiredError);
  });

  it("`*` is REJECTED — it means turning off the concurrency check", () => {
    expect(() => parseIfMatch("*")).toThrow(IfMatchRequiredError);
  });

  it("a value that isn't a positive integer ⇒ 428", () => {
    for (const bad of ['"abc"', '"0"', '"-1"', '"1.5"', '"1,2"']) {
      expect(() => parseIfMatch(bad)).toThrow(IfMatchRequiredError);
    }
  });
});

describe("VersionConflictError", () => {
  it("carries the full three-way diff so the route can return it straight into the 409 body", () => {
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
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.diff).toBe(diff);
  });
});
