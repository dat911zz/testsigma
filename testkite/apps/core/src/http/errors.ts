/**
 * The one place that turns anything thrown into HTTP. Three error sources, three paths:
 *  1. zod schema fail  -> 400 VALIDATION_FAILED + issues
 *  2. AppError         -> its own httpStatus; message returned verbatim only when tenantVisible
 *  3. anything else     -> 500 INTERNAL, log in full, return a generic sentence
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

const GENERIC = "The request could not be completed.";

export function toErrorPayload(err: unknown, requestId: string): { status: number; payload: ErrorPayload } {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      status: 400,
      payload: {
        code: "VALIDATION_FAILED",
        message: "The submitted data is invalid.",
        requestId,
        issues: err.validation.map((i) => i.message ?? String(i)),
      },
    };
  }
  // A response that doesn't match its schema is OUR bug, not the client's.
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
  // The router's 404 must have the same payload shape too — the client only parses ONE error shape.
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "Not found.", requestId: req.id }),
  );
}
