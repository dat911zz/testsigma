/** HỢP LỆ: kernel là nơi duy nhất chạm BullMQ (relay + dispatcher). */
import { Queue } from "bullmq";

export const q = Queue;
