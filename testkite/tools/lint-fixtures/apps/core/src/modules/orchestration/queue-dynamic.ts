/** VI PHẠM CÓ CHỦ ĐÍCH: nạp động BullMQ ngoài kernel vẫn là tự cầm queue client. */
export async function makeQueue(): Promise<unknown> {
  const { Queue } = await import("bullmq");
  return Queue;
}
