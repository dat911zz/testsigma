/**
 * API token: the secret is generated randomly, the DB only ever keeps its SHA-256.
 *
 * Why SHA-256 instead of argon2 like the password: the secret here has 32 bytes of
 * random entropy (not something a human made up), so there's nothing to brute-force;
 * and it's looked up on EVERY request — 0.0026ms/hash (measured) versus argon2's 18ms is
 * the difference between "auth is free" and "auth is a hot path".
 *
 * `prefix` is the first 4 bytes, stored in the clear so the UI can display the token back
 * ("tk_9f3ac21b…") and so logs/audit can name the token without ever touching the secret.
 */
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX_BYTES = 4;
export const TOKEN_SECRET_BYTES = 32;
export const MAX_TOKEN_TTL_DAYS = 365;

export type MintedToken = {
  readonly secret: string;
  readonly prefix: string;
  readonly tokenHash: Buffer;
};

export function mintTokenSecret(): MintedToken {
  const prefix = randomBytes(TOKEN_PREFIX_BYTES).toString("hex");
  const secret = `tk_${prefix}_${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`;
  return { secret, prefix, tokenHash: hashTokenSecret(secret) };
}

export function hashTokenSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

const SECRET_RE = /^tk_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;

export function parseTokenSecret(raw: string): { readonly prefix: string } | null {
  const m = SECRET_RE.exec(raw);
  if (m === null) return null;
  const prefix = m[1];
  if (prefix === undefined) return null;
  return { prefix };
}

/** Expiry is MANDATORY (blueprint §3) — this function has no branch that returns null. */
export function expiryFromDays(days: number, now: Date): Date {
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
    throw new RangeError(`token TTL must be an integer in 1..${MAX_TOKEN_TTL_DAYS} days, got: ${days}`);
  }
  return new Date(now.getTime() + days * 86_400_000);
}
