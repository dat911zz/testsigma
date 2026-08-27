/** HỢP LỆ: luật cấm ĐÚNG danh sách module, không cấm `import()` nói chung —
 * `node:crypto` nạp động vẫn là tính toán thuần. */
export async function hashOf(payload: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(payload).digest("hex");
}
