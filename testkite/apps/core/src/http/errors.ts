/**
 * Một chỗ duy nhất biến mọi thứ ném ra thành HTTP. Ba nguồn lỗi, ba lối:
 *  1. zod schema fail  -> 400 VALIDATION_FAILED + issues
 *  2. AppError         -> httpStatus của chính nó; message chỉ trả nguyên văn khi tenantVisible
 *  3. còn lại          -> 500 INTERNAL, log đầy đủ, trả ra câu chung
 */
import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError } from "@testkite/contract";

export type ErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly issues?: readonly string[];
};

const GENERIC = "Yêu cầu không thực hiện được.";

export function toErrorPayload(err: unknown, requestId: string): { status: number; payload: ErrorPayload } {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      status: 400,
      payload: {
        code: "VALIDATION_FAILED",
        message: "Dữ liệu gửi lên không hợp lệ.",
        requestId,
        issues: err.validation.map((i) => i.message ?? String(i)),
      },
    };
  }
  // Response không khớp schema = lỗi CỦA TA, không phải của client.
  if (isResponseSerializationError(err)) {
    return { status: 500, payload: { code: "INTERNAL", message: GENERIC, requestId } };
  }
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      payload: {
        code: err.code,
        message: err.tenantVisible ? err.message : GENERIC,
        requestId,
        ...(err instanceof Error && "issues" in err && Array.isArray(err.issues)
          ? { issues: err.issues as readonly string[] }
          : {}),
      },
    };
  }
  return { status: 500, payload: { code: "INTERNAL", message: GENERIC, requestId } };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const { status, payload } = toErrorPayload(err, req.id);
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.code(status).send(payload);
  });
  // 404 của router cũng phải cùng hình dạng payload — client chỉ parse MỘT kiểu lỗi.
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "Không tìm thấy.", requestId: req.id }),
  );
}
