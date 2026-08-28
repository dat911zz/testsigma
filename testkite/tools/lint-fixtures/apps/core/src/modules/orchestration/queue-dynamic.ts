/** DELIBERATE VIOLATION: dynamically loading BullMQ outside kernel is still holding a queue client directly. */
export async function makeQueue(): Promise<unknown> {
  const { Queue } = await import("bullmq");
  return Queue;
}
