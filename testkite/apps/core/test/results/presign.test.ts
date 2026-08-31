/**
 * SigV4 query-string presigning. The whole point of this suite is the FIRST test: it pins
 * AWS's own published test vector, so the implementation is checked against the algorithm
 * rather than against itself. A round-trip test ("sign it, then verify it with the same
 * code") would happily agree with its own mistake and only fail later, as an unexplained 403
 * from the object store, on the path a worker uses to upload a 2GB trace.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presignS3Url } from "../../src/modules/results/s3/presign.js";

/**
 * The signature of a PUT, computed from a canonical request written out BY HAND below. This is
 * the same discipline as the AWS-vector test above: comparing the implementation against an
 * independent derivation rather than against itself, so reordering the signed headers — or
 * silently dropping one — is a red test instead of a 403 nobody can explain.
 */
function signatureOf(canonicalRequest: string, amzDate: string, scope: string, secretKey: string): string {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const hmac = (key: Buffer | string, s: string): Buffer =>
    createHmac("sha256", key).update(s).digest();
  const date = amzDate.slice(0, 8);
  const region = scope.split("/")[1] ?? "";
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

describe("SigV4 presign", () => {
  it("reproduces the signature from the AWS documentation's own test vector", () => {
    // GET presigned URL, examplebucket/test.txt, 20130524T000000Z, 86400s, us-east-1.
    // Matching this exact hex is what proves the implementation, not a round-trip against
    // our own code (which would happily agree with its own mistake).
    const url = presignS3Url({
      method: "GET",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      bucket: "",
      key: "/test.txt",
      region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86_400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs a PUT for a tenant-scoped key and stamps the expiry", () => {
    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "tk-artifacts",
      key: "team-a/run-1/chain-1/trace.zip",
      region: "us-east-1",
      accessKey: "k",
      secretKey: "s",
      expiresSeconds: 900,
      contentLength: 3304,
      contentType: "application/zip",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-Date=20260829T101500Z");
    expect(url).toContain("/tk-artifacts/team-a/run-1/chain-1/trace.zip?");
  });

  it("escapes a key with characters that would otherwise break the canonical request", () => {
    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "team a/step 1+2.webp",
      region: "us-east-1",
      accessKey: "k",
      secretKey: "s",
      expiresSeconds: 60,
      contentLength: 12,
      contentType: "image/webp",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain("/b/team%20a/step%201%2B2.webp?");
  });

  it("produces a different signature for a different key (no accidental constant)", () => {
    const base = {
      method: "PUT" as const,
      endpoint: "https://m:9000",
      bucket: "b",
      region: "us-east-1",
      accessKey: "k",
      secretKey: "s",
      expiresSeconds: 60,
      contentLength: 12,
      contentType: "image/webp",
      now: new Date("2026-08-29T10:15:00Z"),
    };
    expect(presignS3Url({ ...base, key: "a" })).not.toBe(presignS3Url({ ...base, key: "b" }));
  });

  /**
   * Deliberate addition to the plan's four. `encodeURIComponent` leaves `!'()*` alone, and a
   * key containing one of them would then be signed over a canonical path the object store
   * does not reconstruct the same way — a signature that is correct here and 403 there.
   * Cheap to state, impossible to notice from a signature hex.
   */
  it("percent-encodes the characters encodeURIComponent leaves behind", () => {
    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "o'brien/(1)*!.png",
      region: "us-east-1",
      accessKey: "k",
      secretKey: "s",
      expiresSeconds: 60,
      contentLength: 12,
      contentType: "image/png",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain("/b/o%27brien/%281%29%2A%21.png?");
  });

  /**
   * The query string is part of the canonical request, so it has to be sorted and encoded the
   * same way on both sides. Pinning the whole prefix catches an ordering change that a
   * `toContain` on one parameter would miss.
   */
  it("emits the five signed query parameters in the canonical (sorted) order", () => {
    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "k",
      region: "eu-central-1",
      accessKey: "AK",
      secretKey: "s",
      expiresSeconds: 900,
      contentLength: 3304,
      contentType: "application/zip",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    const query = url.slice(url.indexOf("?") + 1);
    expect(query.split("&").map((p) => p.split("=")[0])).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ]);
    // The scope is what binds a signature to ONE region and ONE day; a slash inside a query
    // parameter value must be percent-encoded or the canonical query differs from the wire.
    expect(query).toContain("X-Amz-Credential=AK%2F20260829%2Feu-central-1%2Fs3%2Faws4_request");
  });

  /**
   * A PUT signs the SHAPE OF THE BODY, not just its address. Without `content-length` in the
   * signature the URL is a blank cheque: the ticket endpoint refuses to sign a size over the
   * 2GiB-1 cap, and that refusal means nothing at all if the holder of the signed URL can then
   * PUT any number of bytes it likes to the same key. `content-type` is signed for the same
   * reason it is handed back as a header — the metadata row already claims one.
   */
  it("signs a PUT over content-length and content-type as well as host", () => {
    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "k",
      region: "eu-central-1",
      accessKey: "AK",
      secretKey: "s",
      expiresSeconds: 900,
      contentLength: 3304,
      contentType: "application/zip",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    // Semicolons are percent-encoded in the canonical query, so this is the wire form.
    expect(url).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
  });

  /**
   * The canonical request, byte for byte. SigV4 sorts signed headers by name and joins them
   * `name:value\n`; getting that order wrong produces a perfectly well-formed URL whose
   * signature the store cannot reconstruct. Deriving the expected signature from the literal
   * below is the only way to state that requirement in a test — a `toContain` on the header
   * list would pass just as happily with the two headers swapped inside the canonical form.
   */
  it("orders the signed headers exactly as SigV4 requires — content-length, content-type, host", () => {
    const amzDate = "20260829T101500Z";
    const scope = "20260829/eu-central-1/s3/aws4_request";
    const canonicalQuery = [
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "X-Amz-Credential=AK%2F20260829%2Feu-central-1%2Fs3%2Faws4_request",
      `X-Amz-Date=${amzDate}`,
      "X-Amz-Expires=900",
      "X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
    ].join("&");
    const canonicalRequest = [
      "PUT",
      "/b/team-a/job-1/1/trace/art-1",
      canonicalQuery,
      "content-length:3304",
      "content-type:application/zip",
      "host:minio.internal:9000",
      "",
      "content-length;content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const url = presignS3Url({
      method: "PUT",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "team-a/job-1/1/trace/art-1",
      region: "eu-central-1",
      accessKey: "AK",
      secretKey: "s",
      expiresSeconds: 900,
      contentLength: 3304,
      contentType: "application/zip",
      now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain(
      `X-Amz-Signature=${signatureOf(canonicalRequest, amzDate, scope, "s")}`,
    );
  });

  /**
   * The size is IN the signature, so it is not advice: two sizes over the same key are two
   * different signatures, and the one the ticket endpoint signed is the only one the store can
   * verify. (What the store then DOES about a mismatch is its business — that is host-pilot
   * evidence, not something a unit test can claim.)
   */
  it("produces a different signature for a different content length", () => {
    const base = {
      method: "PUT" as const,
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "k",
      region: "eu-central-1",
      accessKey: "AK",
      secretKey: "s",
      expiresSeconds: 900,
      contentType: "application/zip",
      now: new Date("2026-08-29T10:15:00Z"),
    };
    expect(presignS3Url({ ...base, contentLength: 3304 })).not.toBe(
      presignS3Url({ ...base, contentLength: 3305 }),
    );
    expect(presignS3Url({ ...base, contentLength: 3304 })).not.toBe(
      presignS3Url({ ...base, contentLength: 3304, contentType: "image/webp" }),
    );
  });

  /**
   * A GET presign signs `host` alone — which is why the AWS test vector at the top of this file
   * still matches. There is no body to describe, and signing a `content-length` a reader never
   * sends would make every download 403.
   */
  it("keeps a GET signed over host alone", () => {
    const url = presignS3Url({
      method: "GET",
      endpoint: "https://minio.internal:9000",
      bucket: "b",
      key: "k",
      region: "eu-central-1",
      accessKey: "AK",
      secretKey: "s",
      expiresSeconds: 900,
      now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain("X-Amz-SignedHeaders=host&");
  });
});
