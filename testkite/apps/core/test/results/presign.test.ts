/**
 * SigV4 query-string presigning. The whole point of this suite is the FIRST test: it pins
 * AWS's own published test vector, so the implementation is checked against the algorithm
 * rather than against itself. A round-trip test ("sign it, then verify it with the same
 * code") would happily agree with its own mistake and only fail later, as an unexplained 403
 * from the object store, on the path a worker uses to upload a 2GB trace.
 */
import { describe, expect, it } from "vitest";
import { presignS3Url } from "../../src/modules/results/s3/presign.js";

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
});
