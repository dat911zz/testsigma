/**
 * ETag/If-Match cho case (blueprint §4: version + ETag/If-Match, 428 nếu thiếu).
 * ETag = version dạng entity-tag RFC 9110. Thuần — không I/O.
 */
import { IfMatchRequiredError } from "./errors.js";

export function formatETag(version: number): string {
  return `"${String(version)}"`;
}

const ETAG_RE = /^(?:W\/)?"?(\d+)"?$/;

/**
 * Trả về version client đang dựa trên. Ném IfMatchRequiredError (428) cho MỌI
 * đầu vào không phải một version cụ thể — kể cả `*`: `*` nghĩa là "khớp bản nào
 * cũng được", tức tắt kiểm tra đồng thời, đúng thứ cột version sinh ra để chặn.
 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined) throw new IfMatchRequiredError("header vắng mặt");
  const raw = header.trim();
  if (raw.length === 0) throw new IfMatchRequiredError("header rỗng");
  if (raw === "*") {
    throw new IfMatchRequiredError("`*` không được chấp nhận — gửi version cụ thể của bản bạn đang sửa");
  }
  const m = ETAG_RE.exec(raw);
  const captured = m?.[1];
  if (captured === undefined) throw new IfMatchRequiredError(`không đọc được entity-tag: ${raw}`);
  const version = Number(captured);
  if (!Number.isInteger(version) || version <= 0) {
    throw new IfMatchRequiredError(`version phải là số nguyên dương, nhận: ${raw}`);
  }
  return version;
}
