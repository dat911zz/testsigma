/**
 * Canonical JSON: object keys sorted ascending, ARRAY order left untouched.
 *
 * Why this is needed: a revision's sha256 must be stable across runs and across the
 * different paths that build the payload (read from the DB vs. received over HTTP).
 * `JSON.stringify` normally keeps key insertion order ⇒ same data, different hash. Array
 * order is the OPPOSITE case: it's business data (step order), so re-sorting it would
 * corrupt the case.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: non-finite number (NaN/Infinity) makes the hash non-deterministic");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    // exactOptionalPropertyTypes: an optional DTO field yields a real `undefined` —
    // drop the key entirely instead of letting JSON.stringify silently skip it, so the hash matches on both paths.
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
