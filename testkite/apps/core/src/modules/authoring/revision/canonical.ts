/**
 * JSON canonical: khoá object sắp tăng dần, thứ tự MẢNG giữ nguyên.
 *
 * Vì sao cần: sha256 của revision phải ổn định giữa các lần chạy và giữa các
 * đường dựng payload khác nhau (đọc từ DB vs nhận từ HTTP). `JSON.stringify`
 * thường giữ thứ tự chèn khoá ⇒ cùng dữ liệu, khác hash. Thứ tự mảng thì
 * NGƯỢC LẠI: nó là dữ liệu nghiệp vụ (thứ tự step), sắp lại là làm hỏng case.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: số không hữu hạn (NaN/Infinity) làm hash bất định");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    // exactOptionalPropertyTypes: DTO optional cho ra `undefined` thật —
    // bỏ hẳn khoá thay vì để JSON.stringify âm thầm bỏ, để hash khớp cả hai đường.
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
