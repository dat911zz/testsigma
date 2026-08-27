/** HỢP LỆ: kernel là nơi duy nhất chạm BullMQ — nạp tĩnh hay động đều được. */
export async function makeQueue(): Promise<unknown> {
  const { Queue } = await import("bullmq");
  return Queue;
}
