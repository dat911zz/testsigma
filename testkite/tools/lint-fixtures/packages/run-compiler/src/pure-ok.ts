/** VALID: node:crypto is I/O-free, phase 7 needs it to hash the plan. */
import { createHash } from "node:crypto";

export function hashOf(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
