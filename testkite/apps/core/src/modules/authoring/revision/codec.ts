/**
 * Codec revision — zstd NATIVE của Node (node:zlib), không thư viện ngoài.
 *
 * Spike 2026-08-28 (node v22.22.2), payload case 120 step:
 *   raw 34.019 B | zstd-3 2.278 B 0,53ms | zstd-10 1.868 B 0,83ms | zstd-19 1.824 B 28,50ms
 * ⇒ level 10: gần trần tỉ lệ nén, rẻ hơn level 19 tới 34 lần. Đây là đường ghi
 * ĐỒNG BỘ nằm trong transaction, mili-giây ở đây là mili-giây giữ khoá row.
 *
 * Payload bé PHÌNH RA khi nén (đo thật: 69 B -> 78 B) nên phải có nhánh 'raw'.
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
  /** Độ dài JSON canonical (byte) TRƯỚC nén — cột payload_size của bảng revision. */
  readonly rawSize: number;
  /** sha256 hex của JSON canonical, KHÔNG phải của blob nén. */
  readonly sha256: string;
};

function assertZstd(): void {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      "Node runtime thiếu zstd native trong node:zlib — cần Node >= 22.15.0 (xem engines.node)",
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
 * `bytes` nhận Uint8Array chứ không riêng Buffer: PGlite trả cột bytea về dạng
 * Uint8Array còn node-postgres trả Buffer (spike 2026-08-28). Không bao giờ
 * `instanceof Buffer` ở tầng này.
 */
export function decodeRevision(codec: RevisionCodec, bytes: Uint8Array): unknown {
  assertZstd();
  const buf = Buffer.from(bytes);
  const json = codec === "zstd" ? Buffer.from(zlib.zstdDecompressSync(buf)) : buf;
  return JSON.parse(json.toString("utf8")) as unknown;
}
