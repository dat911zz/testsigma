import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFixture } from "./fixture.js";
import type { CompileFixture } from "./fixture.js";
import { canonicalJson, compileRun, COMPILE_ERROR_CODES } from "./index.js";
import type { CompileErrorCode, CompileOutput } from "./index.js";
import type { AuthoredStep, CompileSnapshot, StepKind } from "./snapshot.js";

/**
 * T1 — GOLDEN SUITE: hợp đồng của toàn hệ (blueprint §4, "Testing 8 tầng").
 *
 * Compiler là điểm mà mọi thứ khác tin tưởng: worker chạy đúng cái plan này, dispatcher tính
 * cost từ `stepCount` của plan này, kết quả được quy chiếu về `contentHash` của plan này. Một
 * thay đổi vô ý trong compiler vì thế không hỏng "một test" — nó đổi NGHĨA của dữ liệu đã lưu.
 * Golden file là ảnh chụp có kiểm duyệt của nghĩa đó: đổi được, nhưng phải đổi CÓ CHỦ Ý và
 * diff phải nằm trong PR để người khác đọc.
 *
 * Cách chạy:
 *   pnpm -F @testkite/run-compiler test:golden                  # so khớp (CI, mặc định)
 *   UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden  # ghi lại golden, rồi ĐỌC DIFF
 *
 * `node:fs` ở đây KHÔNG phá luật "compiler PURE": file này là test, đọc fixture từ đĩa; không
 * một module production nào của package import nó (đường sinh plan vẫn thuần tính toán).
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const UPDATE_GOLDEN = process.env["UPDATE_GOLDEN"] === "1";
const UPDATE_HINT = "chạy: UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden";

interface LoadedFixture {
  readonly fixture: CompileFixture;
  readonly file: string;
  readonly goldenFile: string;
}

const FIXTURES = loadFixtures();

function loadFixtures(): readonly LoadedFixture[] {
  if (!existsSync(FIXTURES_DIR)) {
    throw new Error(`Không thấy thư mục fixtures: ${FIXTURES_DIR}`);
  }

  const files = readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".golden.json"))
    .sort(byCodeUnit);

  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    return { fixture: parseFixture(raw, file), file, goldenFile: goldenNameOf(file) };
  });
}

function goldenNameOf(file: string): string {
  return `${file.slice(0, -".json".length)}.golden.json`;
}

// ---------------------------------------------------------------------------
// Hợp đồng của BỘ fixture (không phải của từng fixture)
// ---------------------------------------------------------------------------

describe("bộ golden fixtures", () => {
  it("có ít nhất 20 fixture", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("tên trong fixture trùng tên file, và không trùng nhau", () => {
    for (const { fixture, file } of FIXTURES) {
      expect(`${fixture.name}.json`).toBe(file);
    }
    expect(new Set(FIXTURES.map((f) => f.fixture.name)).size).toBe(FIXTURES.length);
  });

  it("MỖI CompileErrorCode có ít nhất 1 fixture âm (luật §4: không code nào không có bằng chứng)", () => {
    const covered = new Set<CompileErrorCode>();
    for (const { fixture } of FIXTURES) for (const code of fixture.expectCodes) covered.add(code);

    const missing = COMPILE_ERROR_CODES.filter((code) => !covered.has(code));
    expect(missing).toEqual([]);
  });

  it("MỖI construct có ít nhất 1 fixture dương", () => {
    const positives = FIXTURES.filter((f) => f.fixture.expect === "plan").map(
      (f) => f.fixture.input.snapshot,
    );

    const kinds = new Set<StepKind>();
    for (const snapshot of positives) {
      for (const kase of Object.values(snapshot.cases)) {
        walkSteps(kase.steps, (step) => kinds.add(step.kind));
      }
    }
    const missingKinds = (["action", "step_group", "if", "for", "while", "rest"] as const).filter(
      (kind) => !kinds.has(kind),
    );
    expect(missingKinds).toEqual([]);

    const hasPrereqChain = positives.some((s) =>
      Object.values(s.cases).some((c) => c.prereqCaseId !== undefined),
    );
    const hasDeepChain = positives.some((s) => longestChain(s) === 5);
    const hasDataDriven = positives.some((s) =>
      Object.values(s.cases).some((c) => c.dataProfileId !== undefined),
    );
    const hasSecretRef = positives.some((s) => secretRefsOf(s).length > 0);
    const hasKitchenSink = FIXTURES.some((f) => f.fixture.name.includes("kitchen-sink"));

    expect({ hasPrereqChain, hasDeepChain, hasDataDriven, hasSecretRef, hasKitchenSink }).toEqual({
      hasPrereqChain: true,
      hasDeepChain: true,
      hasDataDriven: true,
      hasSecretRef: true,
      hasKitchenSink: true,
    });
  });

  it("không có golden mồ côi (fixture bị xoá phải kéo golden đi theo)", () => {
    const expected = new Set(FIXTURES.map((f) => f.goldenFile));
    const orphans = readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith(".golden.json"))
      .filter((file) => !expected.has(file));

    expect(orphans).toEqual([]);
  });

  it("UPDATE_GOLDEN không bao giờ được bật trong CI (nếu không golden tự viết lại chính nó)", () => {
    expect(UPDATE_GOLDEN && process.env["CI"] !== undefined).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hợp đồng của TỪNG fixture
// ---------------------------------------------------------------------------

describe("golden", () => {
  for (const loaded of FIXTURES) {
    const { fixture, goldenFile } = loaded;

    it(`${fixture.name} — ${fixture.description}`, () => {
      const output = compileRun(fixture.input);

      assertExpectationHolds(fixture, output);
      assertDeterministic(fixture, output);
      assertSecretsStayRefs(fixture, output);
      assertMatchesGolden(goldenFile, output);
    });
  }
});

/** Fixture tự khai dương/âm; runner đối chiếu lời khai với thực tế TRƯỚC khi so golden. */
function assertExpectationHolds(fixture: CompileFixture, output: CompileOutput): void {
  const errorCodes = output.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.code);

  if (fixture.expect === "plan") {
    expect(errorCodes).toEqual([]);
    expect(output.plan).toBeDefined();
    return;
  }

  expect(output.plan).toBeUndefined();
  expect(uniqueSorted(errorCodes)).toEqual(uniqueSorted(fixture.expectCodes));
}

/**
 * Luật nền của cả hệ: cùng input ⇒ cùng plan, cùng hash, mãi mãi. Compile lại NGAY trong test
 * là cách rẻ nhất để bắt một `Date.now()`/`Math.random()`/thứ tự Map lọt vào đường sinh plan.
 */
function assertDeterministic(fixture: CompileFixture, output: CompileOutput): void {
  const again = compileRun(fixture.input);
  expect(canonicalJson(again)).toBe(canonicalJson(output));
  expect(again.plan?.contentHash).toBe(output.plan?.contentHash);
}

/**
 * Secret KHÔNG BAO GIỜ được inline: plan là payload bất biến bị hash, lưu trữ và gửi tới
 * worker — giá trị secret lọt vào đó là lộ vĩnh viễn. Mọi `$secret:X` của snapshot phải còn
 * NGUYÊN VĂN trong plan.
 */
function assertSecretsStayRefs(fixture: CompileFixture, output: CompileOutput): void {
  const { plan } = output;
  if (plan === undefined) return;

  const planJson = canonicalJson(plan);
  for (const ref of secretRefsOf(fixture.input.snapshot)) {
    expect(planJson).toContain(JSON.stringify(ref));
  }
}

function assertMatchesGolden(goldenFile: string, output: CompileOutput): void {
  const goldenPath = join(FIXTURES_DIR, goldenFile);
  const text = goldenTextOf(output);

  if (UPDATE_GOLDEN) {
    writeFileSync(goldenPath, text, "utf8");
    return;
  }

  if (!existsSync(goldenPath)) {
    throw new Error(`Thiếu golden "${goldenFile}" — ${UPDATE_HINT}`);
  }

  expect(text).toBe(readFileSync(goldenPath, "utf8"));
}

/**
 * Golden = CompileOutput ở dạng CANONICAL (khoá sort đệ quy — đúng thứ tự đi vào SHA-256),
 * in thụt lề 2 để diff PR đọc được bằng mắt. `plan` vắng mặt ở fixture âm, đúng như hợp đồng
 * "có ≥1 error ⇒ không sinh plan".
 */
function goldenTextOf(output: CompileOutput): string {
  const canonical: unknown = JSON.parse(canonicalJson(output));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Nguyên thuỷ
// ---------------------------------------------------------------------------

function walkSteps(steps: readonly AuthoredStep[], visit: (step: AuthoredStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.children !== undefined) walkSteps(step.children, visit);
  }
}

/** Số TỔ TIÊN của chuỗi prereq dài nhất trong snapshot (cắt ở 50 để fixture cycle không treo). */
function longestChain(snapshot: CompileSnapshot): number {
  let longest = 0;

  for (const targetId of snapshot.targetCaseIds) {
    let ancestors = 0;
    let currentId = snapshot.cases[targetId]?.prereqCaseId;
    while (currentId !== undefined && ancestors < 50) {
      ancestors += 1;
      currentId = snapshot.cases[currentId]?.prereqCaseId;
    }
    longest = Math.max(longest, ancestors);
  }

  return longest;
}

function secretRefsOf(snapshot: CompileSnapshot): readonly string[] {
  const refs = new Set<string>();

  for (const kase of Object.values(snapshot.cases)) {
    walkSteps(kase.steps, (step) => {
      for (const value of Object.values(step.args ?? {})) {
        if (value.startsWith("$secret:")) refs.add(value);
      }
    });
  }

  return [...refs].sort(byCodeUnit);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
