/**
 * @testkite/runner — worker container: BullMQ consumer × Playwright chromium-headless-shell.
 *
 * BẤT BIẾN (docs/SYSTEM_DESIGN.md §5):
 *  - Worker KHÔNG có credential DB/object-store: plan + secret ref resolve qua
 *    internal HTTP plane với token scope theo run; artifact upload qua presigned PUT.
 *  - AssertionFailure ⇒ job HOÀN THÀNH verdict=failed. Chỉ RetryableInfraError retry.
 *  - Mọi mutation /fleet mang lease_epoch — epoch cũ nhận 409 STALE_EPOCH,
 *    zombie không bao giờ ghi được verdict.
 *  - 1 context = 1 chain, đóng trong finally. Session login truyền tự nhiên trong context.
 */
import { MEMORY } from "./memory-governance.js";

async function main(): Promise<void> {
  // TODO(M3):
  //  1. Đăng ký với control plane, nhận worker id + pool (interactive|batch).
  //  2. Khởi động 1 browser chromium-headless-shell sống lâu trong cgroup lồng
  //     (memory.max = container − 400MB; oom_score_adj: node −500, chromium +500).
  //  3. BullMQ Worker concurrency = MEMORY.contextsPerWorker; claim = conditional
  //     UPDATE bump lease_epoch trên MySQL (qua internal plane), 0 rows = bỏ.
  //  4. Poll RSS từng context 5s (soft/hard theo MEMORY); đọc memory.events sau
  //     kernel-kill để tự chẩn đoán và báo infra-error{browser_oom, epoch, peakRss}.
  //  5. Recycle browser theo MEMORY.recycle; shed 75/85/92%.
  console.log("testkite runner scaffold", MEMORY);
  throw new Error("TODO(M3): worker loop — track fleet của lộ trình");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
