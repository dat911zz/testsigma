/** VALID: kernel is the only place allowed to touch BullMQ (relay + dispatcher). */
import { Queue } from "bullmq";

export const q = Queue;
