/**
 * Case-lifecycle HTTP routes. Each handler does at most three things:
 *   1. auth + scope, 2. parse body/If-Match, 3. run the service inside `withTenant`
 *      and return the DTO + ETag.
 * No business logic lives here — it stays in the services so it can be tested without
 * HTTP. The plugin registers with full `/v1/...` paths and no prefix (the shell's
 * `plugins` array registers it as-is), and stamps `config.tk` with the contract
 * descriptor on every route so the auth hook, OpenAPI and the L3 suite all agree.
 *
 * Check ordering is deliberate: for a mutation we confirm the case EXISTS in the
 * caller's tenant BEFORE parsing If-Match, so a cross-tenant (or missing) id yields
 * 404 rather than leaking a 428. The lock-then-reread inside each service is the
 * authoritative check-then-act; this pre-read only decides 404-vs-428.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  toFastifyPath,
  createCaseBodySchema,
  replaceStepsBodySchema,
  reviewBodySchema,
  createCaseDescriptor,
  getCaseDescriptor,
  replaceStepsDescriptor,
  submitReviewDescriptor,
  withdrawReviewDescriptor,
  reviewCaseDescriptor,
  promoteCaseDescriptor,
  type CaseSummaryDto,
  type RouteDescriptor,
} from "@testkite/contract";
import { projects } from "../../identity/index.js";
import { withTenant, type TenantContext, type TkDb, type TkTx } from "../../kernel/index.js";
import { createCase, replaceSteps, toCaseSummary } from "../case-service.js";
import { decideReview, promoteCase, submitForReview, withdrawReview } from "../review-service.js";
import { formatETag, parseIfMatch } from "../concurrency.js";
import { CaseNotFoundError, VersionConflictError } from "../errors.js";
import { CaseRepo } from "../db/case-repo.js";
import { getAuth, requireScope, type RequestAuth } from "./context.js";

const GENERIC = "The request could not be completed.";

function ifMatchHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers["if-match"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function sendSummary(reply: FastifyReply, status: number, summary: CaseSummaryDto): FastifyReply {
  return reply.code(status).header("etag", formatETag(summary.version)).send(summary);
}

type MethodUpper = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function authoringRoutes(db: TkDb): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof VersionConflictError) {
        return reply.code(error.httpStatus).send({
          code: error.code,
          message: error.message,
          diff: error.diff,
          requestId: request.id,
        });
      }
      if (error instanceof AppError) {
        const issues =
          "issues" in error && Array.isArray((error as { issues?: unknown }).issues)
            ? ((error as { issues: readonly string[] }).issues)
            : undefined;
        return reply.code(error.httpStatus).send({
          code: error.code,
          message: error.tenantVisible ? error.message : GENERIC,
          requestId: request.id,
          ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
        });
      }
      if (error instanceof ZodError) {
        return reply.code(400).send({
          code: "VALIDATION_FAILED",
          message: "The submitted data is invalid.",
          requestId: request.id,
          issues: error.issues.map((i) => i.message),
        });
      }
      request.log.error({ err: error }, "unhandled authoring error");
      return reply.code(500).send({ code: "INTERNAL", message: GENERIC, requestId: request.id });
    });

    /**
     * Shared body for the 5 If-Match mutations: existence check (404) BEFORE If-Match
     * (428), then the service under `withTenant`.
     */
    const runMutation = async <T extends { readonly version: number }>(
      auth: RequestAuth,
      caseId: string,
      ifMatch: string | undefined,
      run: (tx: TkTx, ctx: TenantContext, expectedVersion: number) => Promise<T>,
    ): Promise<T> =>
      withTenant(db, { teamId: auth.teamId }, async (tx) => {
        const ctx: TenantContext = { teamId: auth.teamId };
        const found = await new CaseRepo(tx, ctx).findById(caseId);
        if (found === undefined) throw new CaseNotFoundError(caseId);
        const expectedVersion = parseIfMatch(ifMatch);
        return run(tx, ctx, expectedVersion);
      });

    const route = (
      descriptor: RouteDescriptor,
      handler: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
    ): void => {
      app.route({
        method: descriptor.method.toUpperCase() as MethodUpper,
        url: toFastifyPath(descriptor.path),
        config: { tk: descriptor },
        handler,
      });
    };

    route(createCaseDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const body = createCaseBodySchema.parse(request.body);
      const { projectId } = request.params as { projectId: string };
      const summary = await withTenant(db, { teamId: auth.teamId }, async (tx) => {
        // A project the caller cannot see is a 404 (never a leak, never a raw FK 500).
        const proj = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.teamId, auth.teamId), eq(projects.id, projectId)))
          .limit(1);
        if (proj[0] === undefined) throw new NotFoundError(`Project not found: ${projectId}`);
        return createCase(tx, { teamId: auth.teamId }, { userId: auth.userId }, {
          projectId,
          name: body.name,
          isStepGroup: body.isStepGroup,
          ...(body.prereqCaseId === undefined ? {} : { prereqCaseId: body.prereqCaseId }),
        });
      });
      return sendSummary(reply, 201, summary);
    });

    route(getCaseDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:read");
      const { caseId } = request.params as { caseId: string };
      const summary = await withTenant(db, { teamId: auth.teamId }, async (tx) => {
        const row = await new CaseRepo(tx, { teamId: auth.teamId }).findById(caseId);
        if (row === undefined) throw new CaseNotFoundError(caseId);
        return toCaseSummary(row);
      });
      return sendSummary(reply, 200, summary);
    });

    route(replaceStepsDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const body = replaceStepsBodySchema.parse(request.body);
      const { caseId } = request.params as { caseId: string };
      const summary = await runMutation(auth, caseId, ifMatchHeader(request), (tx, ctx, expectedVersion) =>
        replaceSteps(tx, ctx, { userId: auth.userId }, { caseId, expectedVersion, steps: body.steps }),
      );
      return sendSummary(reply, 200, summary);
    });

    route(submitReviewDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const { caseId } = request.params as { caseId: string };
      const summary = await runMutation(auth, caseId, ifMatchHeader(request), (tx, ctx, expectedVersion) =>
        submitForReview(tx, ctx, { userId: auth.userId }, { caseId, expectedVersion }),
      );
      return sendSummary(reply, 200, summary);
    });

    route(withdrawReviewDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const { caseId } = request.params as { caseId: string };
      const summary = await runMutation(auth, caseId, ifMatchHeader(request), (tx, ctx, expectedVersion) =>
        withdrawReview(tx, ctx, { userId: auth.userId }, { caseId, expectedVersion }),
      );
      return sendSummary(reply, 200, summary);
    });

    route(reviewCaseDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:promote");
      const body = reviewBodySchema.parse(request.body);
      const { caseId } = request.params as { caseId: string };
      const summary = await runMutation(auth, caseId, ifMatchHeader(request), (tx, ctx, expectedVersion) =>
        decideReview(tx, ctx, { userId: auth.userId }, {
          caseId,
          expectedVersion,
          decision: body.decision,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        }),
      );
      return sendSummary(reply, 200, summary);
    });

    route(promoteCaseDescriptor, async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:promote");
      const { caseId } = request.params as { caseId: string };
      const summary = await runMutation(auth, caseId, ifMatchHeader(request), (tx, ctx, expectedVersion) =>
        promoteCase(tx, ctx, { userId: auth.userId }, { caseId, expectedVersion }),
      );
      return sendSummary(reply, 200, summary);
    });
  };
}
