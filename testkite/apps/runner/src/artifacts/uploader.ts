/**
 * Artifact upload, zero-credential (docs/SYSTEM_DESIGN.md §5): the worker holds NO object-store
 * key. The control plane signs a short-lived PUT and the worker just sends bytes to that URL.
 * If a worker is ever compromised, it can write to one object for one run — not to the bucket.
 *
 * Retry policy follows the same taxonomy as everything else: transport failures and 5xx are
 * RETRYABLE; a 4xx is not, because an expired or malformed signature never succeeds by trying
 * harder. The two exceptions are 408 and 429 — the only 4xx that describe a moment rather than
 * the request itself, and the ones an object-store gateway answers when it is simply busy.
 *
 * TWO DEVIATIONS from the plan's code block, both forced by the contract that was settled after
 * the plan was written (packages/contract/src/routes/internal.ts):
 *
 *  1. `UploadRequest` carries `kind`, and its type is DERIVED from `ARTIFACT_KIND_VALUES` — the
 *     closed five-value set (`trace | screenshot | screenshot_bundle | video | log`) the ticket
 *     endpoint validates and `res_artifacts` carries as a CHECK. Deriving instead of re-typing
 *     the five strings means a contract change breaks this file at compile time, rather than
 *     surfacing as a 400 from a signer that then refuses to hand out a URL at all. The kind also
 *     names the artifact in every failure message, so a lost trace and a lost screenshot are
 *     distinguishable in the worker log and in the `infraError.message` the run finally reports.
 *  2. A permanent rejection is a `FatalInfraError`, not a bare `Error` recognised by a message
 *     prefix. One predicate gates every retry in this repo (`err instanceof AppError &&
 *     err.retryable === true`); an ordinary Error is invisible to it, and message sniffing breaks
 *     the moment someone rewords the sentence.
 *
 * The size ceiling (`ARTIFACT_MAX_SIZE_BYTES`) is deliberately NOT re-checked here: the ticket
 * endpoint refuses to sign anything above it, so no presigned target can exist for an oversized
 * body, and the screenshot ring applies the same gate before it even asks (`presignRejection`).
 * A zero-byte body IS checked, because that one is producible locally — a capture or a trace that
 * yielded nothing — and it would store an artifact the contract says cannot exist.
 */
import { ARTIFACT_KIND_VALUES, FatalInfraError, RetryableInfraError } from "@testkite/contract";

/** The closed vocabulary of the ticket endpoint. Derived, never re-typed. */
export type ArtifactKind = (typeof ARTIFACT_KIND_VALUES)[number];

export interface PresignedTarget {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
}

export interface UploadRequest {
  readonly kind: ArtifactKind;
  readonly target: PresignedTarget;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface ArtifactUploader {
  upload(request: UploadRequest): Promise<void>;
}

export interface HttpUploaderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 408 Request Timeout and 429 Too Many Requests: transient by definition, unlike every other 4xx. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Wrapped rather than passed as a bare reference: `fetch` detached from `globalThis` is a shape
 * that has bitten other runtimes, and the default path is the one no test covers.
 */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export class HttpArtifactUploader implements ArtifactUploader {
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HttpUploaderOptions = {}) {
    this.#fetch = options.fetchImpl ?? defaultFetch;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async upload(request: UploadRequest): Promise<void> {
    assertSendable(request);

    let lastError = "";
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const retryableReason = await this.#attempt(request);
      if (retryableReason === null) return;
      lastError = retryableReason;
      if (attempt < this.#maxAttempts) await this.#sleep(backoffMs(attempt));
    }
    throw new RetryableInfraError(
      "network",
      `${request.kind} artifact upload failed after ${this.#maxAttempts} attempts: ${lastError}`,
    );
  }

  /** null = uploaded. A string = a retryable reason. A permanent rejection throws instead. */
  async #attempt(request: UploadRequest): Promise<string | null> {
    let response: Response;
    try {
      response = await this.#fetch(request.target.url, {
        method: request.target.method,
        headers: mergeHeaders(request),
        body: request.body,
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }

    if (response.ok) return null;
    if (response.status < 500 && !TRANSIENT_STATUSES.has(response.status)) {
      throw new FatalInfraError(
        `${request.kind} artifact upload rejected with ${response.status} — the presigned target is not usable, and an expired or malformed signature never becomes valid by trying again`,
      );
    }
    return `http ${response.status}`;
  }
}

/**
 * A `Headers` object, NOT an object spread: header names are case-insensitive, so spreading the
 * signed headers and then adding a `"Content-Type"` key leaves a target signed as `content-type`
 * carrying BOTH entries, which undici serialises as one comma-joined value ("text/plain,
 * text/plain") that no signature covers. `Headers.set` collapses by name the way the wire does.
 */
function mergeHeaders(request: UploadRequest): Headers {
  const headers = new Headers(request.target.headers);
  headers.set("content-type", request.contentType);
  return headers;
}

/**
 * Local refusals — things the far end would answer with a 4xx we do not retry, caught here where
 * the message can still name the cause. A signed `Content-Type` is part of what the signature
 * covers, so sending a different one buys a 403 that reads like an expired URL.
 */
function assertSendable(request: UploadRequest): void {
  if (request.body.length === 0) {
    throw new FatalInfraError(
      `${request.kind} artifact upload has an empty body — the ticket endpoint signs sizeBytes >= 1, so a zero-byte PUT would store an artifact the contract says cannot exist`,
    );
  }

  const signed = signedContentType(request.target.headers);
  const sending = request.contentType.trim().toLowerCase();
  if (signed !== null && signed !== sending) {
    throw new FatalInfraError(
      `${request.kind} artifact upload would send Content-Type "${request.contentType}" against a target signed for "${signed}" — the signature covers that header, so the object store would answer 403 as if the url had expired`,
    );
  }
}

function signedContentType(headers: Readonly<Record<string, string>>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value.trim().toLowerCase();
  }
  return null;
}

/** Exponential with a deterministic shape; jitter is added by the caller's sleep in production. */
function backoffMs(attempt: number): number {
  return Math.min(2_000, 100 * 2 ** (attempt - 1));
}

/** Test double: records what would have been uploaded. */
export class RecordingUploader implements ArtifactUploader {
  readonly uploads: UploadRequest[] = [];

  async upload(request: UploadRequest): Promise<void> {
    this.uploads.push(request);
  }
}
