/**
 * Per-step screenshots on the worker's NVMe scratch, uploaded only when the chain FAILS
 * (docs/SYSTEM_DESIGN.md §5.2). The old system PUT a full-page PNG for every step of every run —
 * ~460GB/month. Here 95-97% of green steps never cost a single PUT, and the failure gallery is
 * still complete.
 *
 * NVMe, not tmpfs: tmpfs pages are charged to the memory cgroup, so a screenshot buffer on tmpfs
 * would eat the very ceiling this milestone exists to defend. This file cannot enforce that — it
 * writes wherever `dir` points — so the guarantee lives in WORKSPACE_DIR and the systemd units.
 *
 * Dedup is EXACT-HASH only. Perceptual near-dup would silently drop visual evidence — the one
 * thing a QA opens the gallery to see. Measured on 2026-08-29: 240 WebP frames of a form-heavy
 * synthetic flow, 231 exact duplicates, 96.2% of bytes saved. That ratio is a property of real
 * WebP frames from a real app, NOT of this class; the tests prove only the mechanism.
 *
 * The bytes come from `EngineContextHandle.screenshotWebp()` — CDP `Page.captureScreenshot` at
 * WebP q70, because the Playwright screenshot API cannot emit WebP at all. The spike measured
 * 2 362 B for a frame that cost 9 503 B as Playwright JPEG q70, so the format choice is what
 * makes a 200-frame ring affordable on scratch in the first place.
 *
 * ONE RING = ONE DIRECTORY. Blobs are content-addressed, so two rings sharing a directory would
 * write the same filename for the same frame and then `discard()` each other's evidence. The
 * caller gives every chain its own directory; the ring creates it on first write.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_MAX_SIZE_BYTES } from "@testkite/contract";
import type { ScreenshotPolicy } from "@testkite/run-compiler";

/** The ticket endpoint signs one content type per screenshot; the uploader must send the same. */
export const SCREENSHOT_CONTENT_TYPE = "image/webp";

/** Why a capture never became a blob. `policy` never lands here: nothing was captured at all. */
export type SkipReason = "empty" | "too_large";

export interface SkippedShot {
  readonly ordinal: number;
  readonly sizeBytes: number;
  readonly reason: SkipReason;
}

/**
 * The presign gate, applied BEFORE a ticket is requested. `artifactRequestSchema` validates
 * `sizeBytes` as `int().min(1).max(ARTIFACT_MAX_SIZE_BYTES)` and answers 400 without signing a
 * URL — so an unusable blob asked for at ticket time would cost the failed chain its whole
 * gallery. The ceiling is imported, never re-typed: one number, one owner (the contract package).
 */
export function presignRejection(sizeBytes: number): SkipReason | null {
  if (sizeBytes < 1) return "empty";
  if (sizeBytes > ARTIFACT_MAX_SIZE_BYTES) return "too_large";
  return null;
}

export interface RingEntry {
  readonly ordinal: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly path: string;
  /** true = this step reuses a blob an earlier step already wrote. */
  readonly deduped: boolean;
}

export interface RingOptions {
  readonly dir: string;
  /** Max distinct blobs kept on scratch; the oldest is evicted first. */
  readonly capacity: number;
  readonly policy: ScreenshotPolicy;
}

export class ScreenshotRing {
  readonly #opts: RingOptions;
  readonly #entries: RingEntry[] = [];
  /** hash -> path, for blobs currently on disk. */
  readonly #blobs = new Map<string, string>();
  /** Insertion order of hashes, for eviction. */
  readonly #order: string[] = [];
  readonly #skipped: SkippedShot[] = [];
  #bytesWritten = 0;
  #dirReady = false;

  constructor(options: RingOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError(`screenshot ring capacity must be an integer >= 1, got ${options.capacity}`);
    }
    this.#opts = options;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  /**
   * Records step `ordinal`'s frame. Returns null when nothing was kept: policy `none`, or a
   * capture the presign gate refuses. Null is not an error — the verdict is decided by
   * assertions, never by whether a screenshot survived — but the caller should log `skipped()`,
   * because a missing frame in the failure gallery is otherwise invisible.
   */
  async push(ordinal: number, bytes: Buffer): Promise<RingEntry | null> {
    if (this.#opts.policy === "none") return null;

    const rejection = presignRejection(bytes.length);
    if (rejection !== null) {
      this.#skipped.push({ ordinal, sizeBytes: bytes.length, reason: rejection });
      return null;
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.#blobs.get(sha256);
    if (existing !== undefined) {
      const entry: RingEntry = { ordinal, sha256, sizeBytes: bytes.length, path: existing, deduped: true };
      this.#entries.push(entry);
      return entry;
    }

    const path = join(this.#opts.dir, `${sha256}.webp`);
    await this.#ensureDir();
    await writeFile(path, bytes);
    this.#bytesWritten += bytes.length;
    this.#blobs.set(sha256, path);
    this.#order.push(sha256);
    await this.#evictIfFull();

    const entry: RingEntry = { ordinal, sha256, sizeBytes: bytes.length, path, deduped: false };
    this.#entries.push(entry);
    return entry;
  }

  /** A snapshot: one record per captured step, duplicates included. */
  entries(): readonly RingEntry[] {
    return [...this.#entries];
  }

  /** Captures that never became a blob, for the worker's log. */
  skipped(): readonly SkippedShot[] {
    return [...this.#skipped];
  }

  /**
   * Unique blobs, in the order their first step produced them, and only those STILL on scratch:
   * an evicted hash is dropped here rather than sent to the ticket endpoint, whose PUT would then
   * fail on a file that no longer exists.
   */
  async keepForUpload(): Promise<readonly RingEntry[]> {
    const seen = new Set<string>();
    const kept: RingEntry[] = [];
    for (const e of this.#entries) {
      if (e.deduped || seen.has(e.sha256)) continue;
      if (!this.#blobs.has(e.sha256)) continue;
      seen.add(e.sha256);
      kept.push(e);
    }
    return kept;
  }

  async discard(): Promise<void> {
    for (const path of this.#blobs.values()) await rm(path, { force: true });
    this.#blobs.clear();
    this.#order.length = 0;
    this.#entries.length = 0;
  }

  async #ensureDir(): Promise<void> {
    if (this.#dirReady) return;
    await mkdir(this.#opts.dir, { recursive: true });
    this.#dirReady = true;
  }

  async #evictIfFull(): Promise<void> {
    while (this.#order.length > this.#opts.capacity) {
      const oldest = this.#order.shift();
      if (oldest === undefined) return;
      const path = this.#blobs.get(oldest);
      this.#blobs.delete(oldest);
      if (path !== undefined) await rm(path, { force: true });
    }
  }
}
