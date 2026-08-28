/**
 * Mật khẩu nội bộ — argon2id, tham số tối thiểu theo OWASP (m=19MiB, t=2, p=1).
 *
 * Vì sao @node-rs/argon2 chứ không `argon2` hay scrypt (spike 2026-08-28):
 *  - `argon2` có script install `node-gyp-build` ⇒ pnpm 10 chặn, cần approve-builds;
 *    @node-rs không có script nào, binary đi bằng optionalDependencies.
 *  - đo thật: 18,2ms/hash vs 35,1ms (argon2) vs 114,8ms (scrypt N=2^15).
 *  - chuỗi PHC liên thông hai chiều với `argon2` (đã cross-verify) ⇒ đổi lib không migrate hash.
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

/** Danh sách chặn tối thiểu — chống mật khẩu "hợp lệ về độ dài" nhưng đoán một phát ra. */
const BANNED = ["password1234", "123456789012", "qwertyuiop12", "testkite1234", "administrator"];

export function passwordPolicy(plain: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (plain.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: `mật khẩu phải ≥ ${PASSWORD_MIN_LENGTH} ký tự` };
  if (plain.length > 200) return { ok: false, reason: "mật khẩu quá dài (≤ 200 ký tự)" };
  if (BANNED.includes(plain.toLowerCase())) return { ok: false, reason: "mật khẩu nằm trong danh sách bị chặn" };
  return { ok: true };
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_PARAMS);
}

/** KHÔNG BAO GIỜ ném: hash bẩn trong DB phải ra "sai mật khẩu", không phải 500. */
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
  if (m === null) return true; // không phải argon2id đúng dạng ⇒ rehash ở lần login kế
  const [, mem, time, par] = m;
  return (
    Number(mem) < ARGON2_PARAMS.memoryCost ||
    Number(time) < ARGON2_PARAMS.timeCost ||
    Number(par) !== ARGON2_PARAMS.parallelism
  );
}
