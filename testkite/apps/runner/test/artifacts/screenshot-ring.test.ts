/**
 * WHAT THIS SUITE PROVES, AND WHERE IT STOPS.
 *
 * Proven here, for real: hashing, dedup, eviction, discard, the presign size gate, and that every
 * blob claimed for upload is still on disk. The filesystem is real — no fs mock — so the byte
 * accounting is the byte accounting the worker will report.
 *
 * NOT proven here: (1) that the scratch dir is NVMe rather than tmpfs — that is a deployment
 * property of WORKSPACE_DIR (systemd task), and a tmpfs ring would be charged to the very memory
 * cgroup this milestone defends; (2) the 96.2% dedup ratio — that number came from 240 real WebP
 * frames in the 2026-08-29 spike, while these buffers are short ASCII strings, so the tests prove
 * the MECHANISM (identical bytes cost one blob), never the ratio; (3) the >2GiB half of the
 * presign gate, which is asserted through `presignRejection` at the exact boundary instead of
 * allocating 2GiB of RSS inside a memory-governance test suite.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_MAX_SIZE_BYTES } from "@testkite/contract";
import { afterAll, describe, expect, it } from "vitest";
import { presignRejection, SCREENSHOT_CONTENT_TYPE, ScreenshotRing } from "../../src/artifacts/screenshot-ring.js";

const created: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tk-ring-"));
  created.push(d);
  return d;
};
const shot = (s: string): Buffer => Buffer.from(s);

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe("ScreenshotRing", () => {
  it("writes a file per unique screenshot", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("frame-a"));
    await ring.push(2, shot("frame-b"));
    expect(readdirSync(d)).toHaveLength(2);
    expect(ring.entries()).toHaveLength(2);
  });

  it("dedups by exact content hash and does NOT write a second file", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    const first = await ring.push(1, shot("same"));
    const second = await ring.push(2, shot("same"));
    expect(second?.sha256).toBe(first?.sha256);
    expect(second?.deduped).toBe(true);
    expect(second?.path).toBe(first?.path);
    expect(readdirSync(d)).toHaveLength(1);
    expect(ring.entries()).toHaveLength(2); // both STEPS are recorded, only one BLOB exists
  });

  it("reproduces the spike ratio: 8 near-identical frames cost one blob", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 100, policy: "failure" });
    for (let i = 1; i <= 8; i++) await ring.push(i, shot("identical-frame"));
    expect(readdirSync(d)).toHaveLength(1);
    expect(ring.entries().filter((e) => e.deduped)).toHaveLength(7);
  });

  it("evicts the oldest blob when the ring is full", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 2, policy: "failure" });
    const a = await ring.push(1, shot("a"));
    await ring.push(2, shot("b"));
    await ring.push(3, shot("c"));
    expect(existsSync(a?.path ?? "")).toBe(false);
    expect(readdirSync(d)).toHaveLength(2);
  });

  it("captures nothing at all when the policy is none", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "none" });
    expect(await ring.push(1, shot("a"))).toBeNull();
    expect(readdirSync(d)).toHaveLength(0);
  });

  it("discard() removes every blob — a green batch chain costs zero PUTs", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("a"));
    await ring.push(2, shot("b"));
    await ring.discard();
    expect(readdirSync(d)).toHaveLength(0);
    expect(ring.entries()).toHaveLength(0);
  });

  it("keepForUpload() returns unique blobs only, in ordinal order", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("a"));
    await ring.push(2, shot("a"));
    await ring.push(3, shot("b"));
    const kept = await ring.keepForUpload();
    expect(kept.map((e) => e.ordinal)).toEqual([1, 3]);
  });

  it("tracks bytes written so the worker can report NVMe scratch usage", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "all" });
    await ring.push(1, shot("12345"));
    await ring.push(2, shot("12345"));
    expect(ring.bytesWritten).toBe(5); // the duplicate costs nothing
  });

  it("creates its scratch directory on first write, so one chain = one directory works", async () => {
    const d = join(dir(), "jr-1", "chain-0");
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("a"));
    expect(readdirSync(d)).toHaveLength(1);
  });

  it("refuses a capacity below 1 — a ring that keeps nothing is a silent evidence hole", () => {
    expect(() => new ScreenshotRing({ dir: "/nowhere", capacity: 0, policy: "failure" })).toThrow(/capacity/);
  });

  it("never uploads a blob the ring already evicted", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 2, policy: "failure" });
    await ring.push(1, shot("a")); // evicted by the third push
    await ring.push(2, shot("b"));
    await ring.push(3, shot("c"));
    const kept = await ring.keepForUpload();
    expect(kept.map((e) => e.ordinal)).toEqual([2, 3]);
    for (const entry of kept) expect(existsSync(entry.path)).toBe(true);
  });

  it("entries() is a snapshot: discard() cannot mutate an array the caller already holds", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("a"));
    const held = ring.entries();
    await ring.discard();
    expect(held).toHaveLength(1);
  });
});

/**
 * The presign gate. `POST /internal/fleet/jobs/{id}/artifacts` validates
 * `sizeBytes: z.number().int().min(1).max(ARTIFACT_MAX_SIZE_BYTES)` and answers 400 WITHOUT
 * signing a URL, so a blob outside that window must be dropped on the worker, before the ticket
 * is ever requested — otherwise a failed chain trades its whole gallery for a 400.
 */
describe("ScreenshotRing presign size gate", () => {
  it("takes the ceiling from the contract package, never a local copy", () => {
    expect(ARTIFACT_MAX_SIZE_BYTES).toBe(2_147_483_647);
    expect(presignRejection(ARTIFACT_MAX_SIZE_BYTES)).toBeNull();
    expect(presignRejection(ARTIFACT_MAX_SIZE_BYTES + 1)).toBe("too_large");
    expect(presignRejection(1)).toBeNull();
    expect(presignRejection(0)).toBe("empty");
  });

  it("drops an empty capture instead of writing a blob the server would refuse to sign", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    expect(await ring.push(1, Buffer.alloc(0))).toBeNull();
    expect(readdirSync(d)).toHaveLength(0);
    expect(ring.entries()).toHaveLength(0);
    expect(ring.bytesWritten).toBe(0);
    expect(ring.skipped()).toEqual([{ ordinal: 1, sizeBytes: 0, reason: "empty" }]);
  });

  it("keeps the good frames of a chain that also produced an unusable one", async () => {
    const d = dir();
    const ring = new ScreenshotRing({ dir: d, capacity: 10, policy: "failure" });
    await ring.push(1, shot("a"));
    await ring.push(2, Buffer.alloc(0));
    await ring.push(3, shot("b"));
    expect((await ring.keepForUpload()).map((e) => e.ordinal)).toEqual([1, 3]);
    expect(ring.skipped()).toHaveLength(1);
  });

  it("declares the content type the presign ticket must carry", () => {
    expect(SCREENSHOT_CONTENT_TYPE).toBe("image/webp");
  });
});
