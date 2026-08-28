/**
 * Taxonomy lỗi của authoring. Mỗi lỗi tự mang `httpStatus` + `code` để route
 * chỉ còn việc ánh xạ, không phải đoán.
 */
import type { ThreeWayDiffDto } from "@testkite/contract";

/**
 * 404 cho MỌI trường hợp "không thấy", kể cả khi id có thật nhưng thuộc tenant
 * khác (blueprint §3 L3: cross-tenant KHÔNG BAO GIỜ 403 — 403 xác nhận id tồn tại).
 */
export class CaseNotFoundError extends Error {
  readonly httpStatus = 404;
  readonly code = "case_not_found";
  constructor(caseId: string) {
    super(`Không tìm thấy case ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/** 428 Precondition Required — mutation không mang If-Match hợp lệ. */
export class IfMatchRequiredError extends Error {
  readonly httpStatus = 428;
  readonly code = "if_match_required";
  constructor(reason: string) {
    super(`Cần header If-Match với version của case: ${reason}`);
    this.name = "IfMatchRequiredError";
  }
}

/** 409 — version client gửi khác version trên server. Mang theo diff 3 chiều. */
export class VersionConflictError extends Error {
  readonly httpStatus = 409;
  readonly code = "version_conflict";
  readonly diff: ThreeWayDiffDto;
  constructor(diff: ThreeWayDiffDto) {
    super(`Case đã đổi: bạn dựa trên version ${diff.baseVersion}, server đang ở ${diff.currentVersion}`);
    this.name = "VersionConflictError";
    this.diff = diff;
  }
}

/** 409 — thao tác không hợp lệ với trạng thái hiện tại (submit case đã ready...). */
export class CaseStateError extends Error {
  readonly httpStatus = 409;
  readonly code = "invalid_case_state";
  constructor(message: string) {
    super(message);
    this.name = "CaseStateError";
  }
}

/**
 * 403 — four-eyes: người sửa cuối tự promote. KHÁC 404 cross-tenant có chủ đích:
 * đây là vi phạm chính sách TRONG cùng tenant, actor đã thấy case rồi, không có
 * gì để rò rỉ; trả 404 ở đây là nói dối rằng case biến mất.
 */
export class FourEyesViolationError extends Error {
  readonly httpStatus = 403;
  readonly code = "four_eyes_self_promote";
  constructor(caseId: string) {
    super(
      `Bạn là người sửa cuối case ${caseId} nên không thể tự promote. ` +
        `Cần người thứ hai, hoặc team bật teams.allow_self_promote.`,
    );
    this.name = "FourEyesViolationError";
  }
}
