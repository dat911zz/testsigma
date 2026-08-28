/** DELIBERATE VIOLATION: a DYNAMIC import breaks purity exactly the same as a static one. */
export async function sneak(): Promise<unknown[]> {
  const fs = await import("node:fs");
  const { Queue } = await import("bullmq");
  return [fs.readFileSync, Queue];
}
