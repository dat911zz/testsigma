/**
 * API token: secret sinh ngẫu nhiên, DB chỉ giữ SHA-256 của nó.
 *
 * Vì sao SHA-256 chứ không argon2 như mật khẩu: secret ở đây có 32 byte entropy
 * ngẫu nhiên (không phải thứ người nghĩ ra) nên không có gì để brute-force; và nó
 * bị tra MỖI request — 0,0026ms/hash (đo thật) so với 18ms của argon2 là khác biệt
 * giữa "auth miễn phí" và "auth là hot path".
 *
 * `prefix` là 4 byte đầu, lưu dạng rõ để UI hiển thị lại token ("tk_9f3ac21b…")
 * và để log/audit gọi tên token mà không bao giờ chạm secret.
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

/** Hạn dùng là BẮT BUỘC (blueprint §3) — hàm này không có nhánh nào trả về null. */
export function expiryFromDays(days: number, now: Date): Date {
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
    throw new RangeError(`hạn token phải là số nguyên trong 1..${MAX_TOKEN_TTL_DAYS} ngày, nhận: ${days}`);
  }
  return new Date(now.getTime() + days * 86_400_000);
}
