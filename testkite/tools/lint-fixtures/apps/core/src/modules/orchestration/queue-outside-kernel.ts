/** DELIBERATE VIOLATION: BullMQ is only allowed to appear inside kernel. */
import { Queue } from "bullmq";

export const q = Queue;
