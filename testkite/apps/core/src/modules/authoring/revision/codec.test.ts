import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { decodeRevision, encodeRevision, ZSTD_LEVEL } from "./codec.js";

/** A case payload large enough for zstd to win — same shape as the 2026-08-28 spike. */
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
  it("sorts object keys so two differently-ordered objects produce the SAME string", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("KEEPS array order untouched — step order is data, not noise", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sorts keys RECURSIVELY, including objects nested inside arrays", () => {
    expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });

  it("drops an undefined prop instead of throwing — payloads are built from optional DTOs", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects a non-finite number — NaN/Infinity would make the hash non-deterministic", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/);
  });
});

describe("encodeRevision", () => {
  it("zstd-compresses a large payload and shrinks it by at least 5x", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.codec).toBe("zstd");
    expect(enc.bytes.length * 5).toBeLessThan(enc.rawSize);
  });

  it("the blob carries the zstd magic number 28 b5 2f fd", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.bytes.subarray(0, 4).toString("hex")).toBe("28b52ffd");
  });

  it("a SMALL payload falls back to the raw codec — compression would grow it (spike: 69B -> 78B)", () => {
    const enc = encodeRevision({ id: "x" });
    expect(enc.codec).toBe("raw");
    expect(enc.bytes.length).toBe(enc.rawSize);
  });

  it("rawSize is the canonical JSON length, not the blob length", () => {
    const payload = bigPayload(40);
    const enc = encodeRevision(payload);
    expect(enc.rawSize).toBe(Buffer.byteLength(canonicalJson(payload), "utf8"));
  });

  it("sha256 is computed over the canonical JSON so it does NOT change when keys are permuted", () => {
    const a = encodeRevision({ name: "n", steps: [] });
    const b = encodeRevision({ steps: [], name: "n" });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic: compressing twice produces the EXACT same bytes (a precondition for the golden test)", () => {
    const p = bigPayload(40);
    expect(encodeRevision(p).bytes.equals(encodeRevision(p).bytes)).toBe(true);
  });

  it("the pinned compression level is 10", () => {
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

  it("accepts a Uint8Array — PGlite returns bytea in that form, NOT as a Buffer", () => {
    const enc = encodeRevision(bigPayload(40));
    const asU8 = new Uint8Array(enc.bytes);
    expect(asU8 instanceof Buffer).toBe(false);
    expect(decodeRevision("zstd", asU8)).toEqual(bigPayload(40));
  });
});
