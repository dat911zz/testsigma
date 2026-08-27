/**
 * Hằng liệt kê của domain (docs/SYSTEM_DESIGN.md §2, §4) — module LÁ, KHÔNG import gì.
 *
 * Vì sao tách khỏi `index.ts`: barrel `index.ts` re-export `./schemas/index.js`, mà
 * `schemas/run.ts` cần đúng các hằng này. Để schema đọc chúng qua barrel là tạo vòng
 * import — dưới ESM thật thân barrel chưa chạy khi schema đọc hằng, nổ
 * `ReferenceError: Cannot access 'RUN_VERDICTS' before initialization`.
 * Đặt hằng ở lá, cả barrel lẫn schema cùng import xuôi ⇒ hết vòng.
 *
 * Bề mặt công khai không đổi: `index.ts` re-export nguyên vẹn file này.
 */

/** Verdict của một run — compile_error/blocked xảy ra TRƯỚC khi bất kỳ browser nào khởi động. */
export const RUN_VERDICTS = [
  "passed",
  "failed",
  "compile_error",
  "blocked", // cổng health môi trường (phase 7.5) chặn
  "aborted_early", // phanh mass-failure: 25 chain đầu fail cùng signature
  "cancelled",
] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Trạng thái job (job_runs — queue of record trong MySQL). */
export const JOB_STATUSES = [
  "pending",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rejected_quota",
  "unknown_after_restore", // quarantine bắt buộc sau restore DB, TRƯỚC khi reaper chạy
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ["chain", "element_verify", "capture_session", "env_probe"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const LANES = ["interactive", "batch"] as const;
export type Lane = (typeof LANES)[number];
