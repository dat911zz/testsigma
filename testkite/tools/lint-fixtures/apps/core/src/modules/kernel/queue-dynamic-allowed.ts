/** VALID: kernel is the only place allowed to touch BullMQ — static or dynamic import, either is fine. */
export async function makeQueue(): Promise<unknown> {
  const { Queue } = await import("bullmq");
  return Queue;
}
