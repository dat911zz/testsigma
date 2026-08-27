/** HỢP LỆ: node:crypto là I/O-free, phase 7 cần nó để băm plan. */
import { createHash } from "node:crypto";

export function hashOf(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
