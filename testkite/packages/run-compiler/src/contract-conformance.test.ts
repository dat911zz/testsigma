/**
 * Chứng minh schema của `@testkite/contract` và type snapshot của compiler
 * chưa lệch nhau — bằng DỮ LIỆU THẬT: toàn bộ fixture của golden suite.
 *
 * Đây là test một chiều có chủ đích: mọi thứ compiler ăn được thì biên API
 * phải nhận. Chiều ngược (API nhận gì compiler cũng ăn) là việc của compiler.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSnapshotSchema } from "@testkite/contract";
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES } from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".golden.json"))
  .sort();

describe("contract ⇄ compiler conformance", () => {
  it("corpus fixture không rỗng (nếu rỗng thì test này vô nghĩa)", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtureFiles)("fixture %s: snapshot lọt compileSnapshotSchema", (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
    const snapshot = (raw as { snapshot: unknown }).snapshot;
    const result = compileSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      throw new Error(`${file} không qua schema contract:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it("COMPILE_ERROR_CODES re-export từ contract, không phải bản sao cục bộ", async () => {
    const contract = await import("@testkite/contract");
    expect(COMPILE_ERROR_CODES).toBe(contract.COMPILE_ERROR_CODES);
  });
});
