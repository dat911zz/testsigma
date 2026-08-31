/**
 * WHAT THIS SUITE PROVES, AND WHERE IT STOPS.
 *
 * Proven here, for real: the exact request the worker sends (the presigned URL verbatim, PUT, the
 * content type), that the worker adds NO credential of its own, the retry taxonomy (transport
 * failure, 5xx and the two transient 4xx are retried; every other 4xx is not), the attempt
 * ceiling with its backoff shape, and that the artifact vocabulary is exactly the five kinds the
 * settled contract allows.
 *
 * NOT proven here: that a presigned URL is actually accepted by an object store. `fetch` is a
 * stub in every test below, so signature validity, `expiresAt` clock skew and MinIO's own error
 * bodies are untouched — those belong to the control plane's signer and are only exercised
 * end-to-end against a real bucket (owned by the M3 orchestration plan). A green suite here
 * means the worker speaks correctly, not that the far end agrees.
 */
import { ARTIFACT_KIND_VALUES, FatalInfraError, RetryableInfraError } from "@testkite/contract";
import { describe, expect, it, vi } from "vitest";
import { HttpArtifactUploader, type PresignedTarget, RecordingUploader } from "../../src/artifacts/uploader.js";

/**
 * What the ticket endpoint actually hands back: BOTH signed headers. The control plane signs a
 * PUT over `content-length;content-type;host`, so these two values are not advice — they are
 * the request the signature describes. `zip()` is three bytes, hence the "3".
 */
const target: PresignedTarget = {
  url: "https://minio.internal/bucket/trace.zip?X-Amz-Signature=abc",
  method: "PUT",
  headers: { "Content-Type": "application/zip", "Content-Length": "3" },
};

const ok = (): Response => new Response(null, { status: 200 });
const status = (code: number): Response => new Response(null, { status: code });
const noSleep = async (): Promise<void> => {};
const zip = (): Buffer => Buffer.from("zip");

const uploadTrace = { kind: "trace", target, body: zip(), contentType: "application/zip" } as const;

describe("HttpArtifactUploader", () => {
  it("PUTs the body to exactly the presigned url, signing nothing itself", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await new HttpArtifactUploader({ fetchImpl, sleep: noSleep }).upload(uploadTrace);

    const call = fetchImpl.mock.calls.at(0);
    if (call === undefined) throw new Error("fetch was never called");
    const [url, init] = call;
    expect(url).toBe(target.url);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toEqual(zip());
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/zip");
    // The second signed header. Sending the content type but not the length would be a request
    // the store cannot verify against the signature it was handed.
    expect(headers.get("content-length")).toBe("3");
    // Zero-credential: nothing that looks like an object-store credential may be added here.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-amz-credential")).toBeNull();
    expect(headers.get("x-amz-security-token")).toBeNull();
  });

  it("retries a 5xx and succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok());
    await new HttpArtifactUploader({ fetchImpl, sleep: noSleep }).upload(uploadTrace);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts with a RETRYABLE network infra error, backing off between tries", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => status(500));
    const slept: number[] = [];
    const uploader = new HttpArtifactUploader({
      fetchImpl,
      maxAttempts: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const error = await uploader.upload(uploadTrace).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RetryableInfraError);
    expect(error).toMatchObject({ code: "network", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // One sleep BETWEEN attempts, never after the last one — waiting to then give up is dead time.
    expect(slept).toEqual([100, 200]);
  });

  it("does NOT retry a 403 — an expired signature will never succeed by trying harder", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => status(403));
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep, maxAttempts: 5 });

    const error = await uploader.upload(uploadTrace).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FatalInfraError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toMatch(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown network error too, not only an http status", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    await new HttpArtifactUploader({ fetchImpl, sleep: noSleep }).upload(uploadTrace);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 408 and 429, the two 4xx that are transient by definition", async () => {
    for (const transient of [408, 429]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(status(transient)).mockResolvedValueOnce(ok());
      await new HttpArtifactUploader({ fetchImpl, sleep: noSleep }).upload(uploadTrace);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("accepts every artifact kind the settled contract allows, and only those five", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep });
    // Passing each contract value into `UploadRequest["kind"]` is the compile-time half: the
    // uploader's vocabulary cannot be narrower than the enum the ticket endpoint validates.
    for (const kind of ARTIFACT_KIND_VALUES) {
      await uploader.upload({ kind, target, body: zip(), contentType: "application/zip" });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    // And the runtime half: it cannot be wider either. A sixth kind is a 400 at ticket time.
    expect([...ARTIFACT_KIND_VALUES]).toEqual(["trace", "screenshot", "screenshot_bundle", "video", "log"]);
  });

  it("refuses an empty body without touching the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep });

    const error = await uploader
      .upload({ kind: "screenshot", target, body: Buffer.alloc(0), contentType: "image/webp" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FatalInfraError);
    expect((error as Error).message).toMatch(/empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a content type that contradicts the signed header, instead of earning a mystery 403", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep });

    const error = await uploader
      .upload({ kind: "trace", target, body: zip(), contentType: "image/webp" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FatalInfraError);
    expect((error as Error).message).toMatch(/application\/zip/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the content type when the signed headers omit it, and ignores header casing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const bare: PresignedTarget = { url: target.url, method: "PUT", headers: {} };
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep });

    await uploader.upload({ kind: "log", target: bare, body: zip(), contentType: "text/plain" });
    await uploader.upload({
      kind: "log",
      target: { url: target.url, method: "PUT", headers: { "content-TYPE": "TEXT/plain", "CONTENT-length": "3" } },
      body: zip(),
      contentType: "text/plain",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sent = fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get("content-type"));
    expect(sent).toEqual(["text/plain", "text/plain"]);
  });

  /**
   * The size ceiling lives in the control plane, which refuses to sign anything over it — and
   * the signature is what carries that refusal onto the wire, because `content-length` is one of
   * the headers it covers. A body that is not the size the ticket named is therefore a request
   * nobody signed, and the worker must say so HERE, where the message can name the cause, rather
   * than spend four attempts on a rejection whose reason is invisible.
   *
   * NOTE ON WHAT THIS DOES *NOT* PROVE: `fetch` is a stub, so this says nothing about how a real
   * object store answers an unsigned mismatch. The claim is about the signature's contents; the
   * far end's behaviour is host-pilot evidence.
   */
  it("refuses to PUT a body whose length differs from the signed content-length", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const uploader = new HttpArtifactUploader({ fetchImpl, sleep: noSleep });

    const error = await uploader
      .upload({
        kind: "trace",
        // Signed for three bytes, handed nine.
        target,
        body: Buffer.from("nine byte"),
        contentType: "application/zip",
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FatalInfraError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toMatch(/9/);
    expect((error as Error).message).toMatch(/3/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the body's own length when the target carries no signed content-length", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const bare: PresignedTarget = { url: target.url, method: "PUT", headers: {} };
    await new HttpArtifactUploader({ fetchImpl, sleep: noSleep }).upload({
      kind: "log",
      target: bare,
      body: Buffer.from("nine byte"),
      contentType: "text/plain",
    });
    const call = fetchImpl.mock.calls.at(0);
    if (call === undefined) throw new Error("fetch was never called");
    expect(new Headers(call[1]?.headers).get("content-length")).toBe("9");
  });
});

describe("RecordingUploader", () => {
  it("records what would have been uploaded and never touches the network", async () => {
    const uploader = new RecordingUploader();
    await uploader.upload(uploadTrace);
    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.uploads.at(0)).toMatchObject({ kind: "trace", contentType: "application/zip" });
  });
});
