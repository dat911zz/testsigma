/** VI PHẠM CÓ CHỦ ĐÍCH: nạp ĐỘNG cũng phá purity y hệt nạp tĩnh. */
export async function sneak(): Promise<unknown[]> {
  const fs = await import("node:fs");
  const { Queue } = await import("bullmq");
  return [fs.readFileSync, Queue];
}
