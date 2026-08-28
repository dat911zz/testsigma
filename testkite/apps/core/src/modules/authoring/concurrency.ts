/**
 * ETag/If-Match for a case (blueprint §4: version + ETag/If-Match, 428 if missing).
 * ETag = version as an RFC 9110 entity-tag. Pure — no I/O.
 */
import { IfMatchRequiredError } from "./errors.js";

export function formatETag(version: number): string {
  return `"${version}"`;
}

const ETAG_RE = /^(?:W\/)?"?(\d+)"?$/;

/**
 * Returns the version the client is basing its edit on. Throws IfMatchRequiredError (428)
 * for ANY input that isn't a concrete version — including `*`: `*` means "match any
 * version", i.e. turning off the concurrency check, exactly what the version column exists to prevent.
 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined) throw new IfMatchRequiredError("header is missing");
  const raw = header.trim();
  if (raw.length === 0) throw new IfMatchRequiredError("header is empty");
  if (raw === "*") {
    throw new IfMatchRequiredError("`*` is not accepted — send the specific version you're editing");
  }
  const m = ETAG_RE.exec(raw);
  const captured = m?.[1];
  if (captured === undefined) throw new IfMatchRequiredError(`could not parse entity-tag: ${raw}`);
  const version = Number(captured);
  if (!Number.isInteger(version) || version <= 0) {
    throw new IfMatchRequiredError(`version must be a positive integer, got: ${raw}`);
  }
  return version;
}
