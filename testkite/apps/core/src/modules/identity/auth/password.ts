/**
 * Internal password hashing — argon2id, OWASP minimum parameters (m=19MiB, t=2, p=1).
 *
 * Why @node-rs/argon2 instead of `argon2` or scrypt (spike 2026-08-28):
 *  - `argon2` has a `node-gyp-build` install script ⇒ pnpm 10 blocks it, needs approve-builds;
 *    @node-rs ships no scripts, the binary comes via optionalDependencies.
 *  - measured: 18.2ms/hash vs 35.1ms (argon2) vs 114.8ms (scrypt N=2^15).
 *  - the PHC string is cross-compatible with `argon2` (cross-verified) ⇒ switching libs doesn't need a hash migration.
 */
import { Algorithm, hash, verify } from "@node-rs/argon2";

export const ARGON2_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_MIN_LENGTH = 12;

/** Minimal denylist — blocks passwords that are "long enough" but guessed in one try. */
const BANNED = ["password1234", "123456789012", "qwertyuiop12", "testkite1234", "administrator"];

export function passwordPolicy(plain: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (plain.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: `password must be ≥ ${PASSWORD_MIN_LENGTH} characters` };
  if (plain.length > 200) return { ok: false, reason: "password too long (≤ 200 characters)" };
  if (BANNED.includes(plain.toLowerCase())) return { ok: false, reason: "password is on the denylist" };
  return { ok: true };
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_PARAMS);
}

/** NEVER throws: a dirty hash in the DB must come back as "wrong password", not a 500. */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  if (stored.length === 0) return false;
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

export function needsRehash(stored: string): boolean {
  const m = PHC.exec(stored);
  if (m === null) return true; // not a well-formed argon2id string ⇒ rehash on next login
  const [, mem, time, par] = m;
  return (
    Number(mem) < ARGON2_PARAMS.memoryCost ||
    Number(time) < ARGON2_PARAMS.timeCost ||
    Number(par) !== ARGON2_PARAMS.parallelism
  );
}
