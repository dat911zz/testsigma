/**
 * Hình dạng ảnh chụp lưu trong `aut_case_revisions.payload` (sau canonical + zstd).
 *
 * KHÔNG có `ordinal`: vị trí được mã hoá bằng `after` = id step liền trước CÙNG CHA.
 * Lý do đo được (spike 2026-08-28): ordinal là số nên chèn một step làm đánh số lại
 * cả đuôi ⇒ mọi thuật toán diff báo N thay đổi cho 1 hành động. Với `after`, chèn
 * một step chỉ chạm đúng hai mục.
 */
import type { StepKindDto } from "@testkite/contract";

export interface RevisionLoop {
  readonly dataProfileId?: string;
  readonly maxIterations?: number;
}

export interface RevisionRest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly storeAs?: string;
}

export interface RevisionStep {
  readonly id: string;
  readonly kind: StepKindDto;
  /** null = step gốc của case. */
  readonly parentId: string | null;
  /** null = step đầu tiên trong danh sách anh em. */
  readonly after: string | null;
  readonly renderedSentence: string;
  readonly verbOpKey?: string;
  readonly elementId?: string;
  readonly args?: Record<string, string>;
  readonly stepGroupCaseId?: string;
  readonly conditionExpected?: readonly string[];
  readonly loop?: RevisionLoop;
  readonly rest?: RevisionRest;
}

export interface RevisionCase {
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string;
  readonly dataProfileId?: string;
}

export interface RevisionPayload {
  readonly case: RevisionCase;
  /** Danh sách PHẲNG mọi step (kể cả step con) — cây dựng lại từ parentId + after. */
  readonly steps: readonly RevisionStep[];
}
