/**
 * Revision codec — Node's NATIVE zstd (node:zlib), no third-party library.
 *
 * Spike 2026-08-28 (node v22.22.2), a 120-step case payload:
 *   raw 34,019 B | zstd-3 2,278 B 0.53ms | zstd-10 1,868 B 0.83ms | zstd-19 1,824 B 28.50ms
 * ⇒ level 10: close to the compression-ratio ceiling, up to 34x cheaper than level 19. This
 * is a SYNCHRONOUS write path inside a transaction, so a millisecond here is a millisecond
 * holding the row lock.
 *
 * A small payload GROWS when compressed (measured: 69 B -> 78 B), so a 'raw' branch is required.
 */
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { canonicalJson } from "./canonical.js";

export const REVISION_CODECS = ["zstd", "raw"] as const;
export type RevisionCodec = (typeof REVISION_CODECS)[number];

export const ZSTD_LEVEL = 10;

export type EncodedRevision = {
  readonly codec: RevisionCodec;
  readonly bytes: Buffer;
  /** Length of the canonical JSON (bytes) BEFORE compression — the revision table's payload_size column. */
  readonly rawSize: number;
  /** sha256 hex of the canonical JSON, NOT of the compressed blob. */
  readonly sha256: string;
};

function assertZstd(): void {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      "Node runtime is missing native zstd in node:zlib — requires Node >= 22.15.0 (see engines.node)",
    );
  }
}

export function encodeRevision(payload: unknown): EncodedRevision {
  assertZstd();
  const json = canonicalJson(payload);
  const raw = Buffer.from(json, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const compressed = Buffer.from(
    zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
  );
  if (compressed.length < raw.length) {
    return { codec: "zstd", bytes: compressed, rawSize: raw.length, sha256 };
  }
  return { codec: "raw", bytes: raw, rawSize: raw.length, sha256 };
}

/**
 * `bytes` accepts a Uint8Array, not just a Buffer: PGlite returns the bytea column as a
 * Uint8Array while node-postgres returns a Buffer (spike 2026-08-28). Never
 * `instanceof Buffer` at this layer.
 */
export function decodeRevision(codec: RevisionCodec, bytes: Uint8Array): unknown {
  assertZstd();
  const buf = Buffer.from(bytes);
  const json = codec === "zstd" ? Buffer.from(zlib.zstdDecompressSync(buf)) : buf;
  return JSON.parse(json.toString("utf8")) as unknown;
}
