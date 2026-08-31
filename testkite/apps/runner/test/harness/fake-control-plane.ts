/**
 * The control plane, faked in-process — but faked against the SETTLED contract
 * (`packages/contract/src/routes/internal.ts`), never against a hand-written idea of it.
 *
 * Four things make this harness worth more than a mocked `fetch`:
 *   1. it ROUTES off `INTERNAL_ROUTES`, so a path renamed in the contract stops matching here
 *      and the suite goes red instead of the worker going quiet in production;
 *   2. it parses every request body with the CONTRACT'S OWN schema and answers
 *      `400 VALIDATION_FAILED` exactly as the real plane does — a client that sends a field the
 *      contract forbids fails in CI, not at 3am;
 *   3. it checks each route's credential (bootstrap / worker / run) the way the real auth hook
 *      does, which is what turns "job mutations use the RUN token" into a proven statement
 *      rather than a comment;
 *   4. it validates its OWN answer against the descriptor's response schema, because a fake
 *      that lies about the far end is worse than no fake at all.
 *
 * WHAT IT CANNOT PROVE. Nothing here touches Postgres: lease reaping, `FOR UPDATE SKIP LOCKED`
 * claim semantics, run-token TTL, artifact signing and cross-tenant isolation are proven by the
 * control plane's own suites in `apps/core`. A green run here means THE WORKER SPEAKS THE
 * CONTRACT — not that the far end agrees.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { INTERNAL_ROUTES, pathParamNames, type InternalRouteDescriptor } from "@testkite/contract";
import type { RunPlan } from "@testkite/run-compiler";

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly auth: string | undefined;
}

/**
 * A canned answer, consumed one per request. It is how a test asks for the answers a healthy
 * plane rarely gives — 429 with its `Retry-After`, a 503 burst, 401, 404, either 410.
 */
export interface ForcedAnswer {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface CompiledRoute {
  readonly descriptor: InternalRouteDescriptor;
  readonly method: string;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
}

/** The contract's own route table, compiled once into matchers. No path string is typed twice. */
const COMPILED: readonly CompiledRoute[] = INTERNAL_ROUTES.map((descriptor) => ({
  descriptor,
  method: descriptor.method.toUpperCase(),
  pattern: new RegExp(`^${descriptor.path.replace(/\{[^}]+\}/gu, "([^/]+)")}$`, "u"),
  paramNames: pathParamNames(descriptor.path),
}));

/** The three credentials, distinct on purpose: presenting the wrong one must read as 401. */
export const FAKE_BOOTSTRAP_TOKEN = "tkb_fake_bootstrap";
export const FAKE_WORKER_TOKEN = "tkw_fake_worker";
export const FAKE_RUN_TOKEN = "tkr_fake_run";

const HEARTBEAT_INTERVAL_MS = 5_000;

export class FakeControlPlane {
  readonly calls: RecordedCall[] = [];
  /** Ids this plane hands out. Real uuids: `claimedJobSchema` rejects anything else. */
  readonly jobRunId = randomUUID();
  readonly runId = randomUUID();
  readonly teamId = randomUUID();
  readonly projectId = randomUUID();

  /** The epoch this plane considers current; raise it to simulate a reaper bumping the lease. */
  currentEpoch = 1;
  nextJob: { readonly chainKey: string; readonly plan: RunPlan } | null = null;
  workerCommand: "continue" | "drain" = "continue";
  jobCommand: "continue" | "drain" | "cancel" = "continue";
  /** Whether `register` answers "this host was already put into drain". */
  drain = false;
  readonly forced: ForcedAnswer[] = [];

  #server: Server | null = null;
  #port = 0;
  #workerId: string | null = null;
  readonly #seenSeq = new Set<number>();

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        this.#handle(req, res, raw);
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    this.#port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    // `fetch` keeps its sockets alive; without this the close callback waits out the keep-alive
    // timeout and the suite hangs on teardown rather than on anything meaningful.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = null;
  }

  #handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const path = (req.url ?? "").split("?")[0] ?? "";
    let body: Record<string, unknown> = {};
    if (raw !== "") {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.#error(res, 400, "VALIDATION_FAILED", "body is not JSON");
        return;
      }
    }
    this.calls.push({
      method: req.method ?? "",
      path,
      body,
      auth: req.headers.authorization,
    });

    const route = COMPILED.find((r) => r.method === (req.method ?? "") && r.pattern.test(path));
    if (route === undefined) {
      this.#error(res, 404, "NOT_FOUND", "Not found.");
      return;
    }

    const presented = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1] ?? null;
    if (presented === null || presented !== this.#expectedToken(route)) {
      this.#error(res, 401, "UNAUTHORIZED", "The request could not be completed.");
      return;
    }

    const forced = this.forced.shift();
    if (forced !== undefined) {
      this.#send(
        res,
        forced.status,
        { code: forced.code ?? "FORCED", message: forced.message ?? "forced answer", requestId: randomUUID() },
        forced.headers ?? {},
      );
      return;
    }

    const parsed = route.descriptor.body?.safeParse(body);
    if (parsed !== undefined && !parsed.success) {
      this.#error(
        res,
        400,
        "VALIDATION_FAILED",
        "The submitted data is invalid.",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      );
      return;
    }
    const valid: Record<string, unknown> = (parsed?.data as Record<string, unknown> | undefined) ?? body;
    const params = this.#params(route, path);

    if (route.descriptor.credential === "worker" && params["workerId"] !== undefined && params["workerId"] !== this.#workerId) {
      this.#error(res, 401, "UNAUTHORIZED", "worker scope mismatch");
      return;
    }
    if (route.descriptor.credential === "run") {
      // A job the token does not name is invisible: 404, never a 403 that would confirm it exists.
      if (params["jobRunId"] !== this.jobRunId) {
        this.#error(res, 404, "NOT_FOUND", "Job run not found.");
        return;
      }
      if (valid["leaseEpoch"] !== this.currentEpoch) {
        this.#send(res, 409, {
          code: "STALE_EPOCH",
          message: "The request could not be completed.",
          requestId: randomUUID(),
          currentEpoch: this.currentEpoch,
        });
        return;
      }
    }

    this.#answer(res, route, valid);
  }

  #answer(res: ServerResponse, route: CompiledRoute, body: Record<string, unknown>): void {
    switch (route.descriptor.operationId) {
      case "internalRegister": {
        this.#workerId = String(body["workerId"]);
        this.#ok(res, route, 200, {
          workerId: this.#workerId,
          lane: body["lane"],
          workerToken: FAKE_WORKER_TOKEN,
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
          drain: this.drain,
        });
        return;
      }
      case "internalWorkerHeartbeat": {
        this.#ok(res, route, 200, {
          command: this.workerCommand,
          workerTokenRenewedAt: new Date().toISOString(),
        });
        return;
      }
      case "internalClaim": {
        const job = this.nextJob;
        // An empty queue is the normal answer for most of a fleet's life: 204, no body at all.
        if (job === null) {
          this.#send(res, 204, null);
          return;
        }
        this.nextJob = null;
        this.#ok(res, route, 200, {
          jobRunId: this.jobRunId,
          runId: this.runId,
          teamId: this.teamId,
          projectId: this.projectId,
          chainKey: job.chainKey,
          attempt: 1,
          leaseEpoch: this.currentEpoch,
          leaseDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
          runToken: FAKE_RUN_TOKEN,
          plan: job.plan,
        });
        return;
      }
      case "internalJobHeartbeat": {
        this.#ok(res, route, 200, {
          leaseDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
          command: this.jobCommand,
        });
        return;
      }
      case "internalEvents": {
        // Idempotent by seq, and a replay is a SUCCESS: at-least-once delivery makes a resend
        // normal traffic, so 202 with `duplicate: true` is the honest answer, not a 409.
        const seq = Number(body["seq"]);
        const duplicate = this.#seenSeq.has(seq);
        this.#seenSeq.add(seq);
        this.#ok(res, route, 202, { accepted: true, duplicate });
        return;
      }
      case "internalArtifacts": {
        this.#ok(res, route, 200, {
          artifactId: randomUUID(),
          method: "PUT",
          url: `${this.url}/blob/${String(body["sha256"])}`,
          headers: { "Content-Type": String(body["contentType"]) },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
        return;
      }
      case "internalComplete": {
        // Exactly one of the two shapes, enforced by the handler and not by the schema — the
        // real plane answers 400 here too, so a worker that reports nothing finds out in CI.
        const infra = body["infraError"];
        if (body["verdict"] === undefined && (infra === null || infra === undefined)) {
          this.#error(res, 400, "VALIDATION_FAILED", "A complete needs either a verdict or an infraError.");
          return;
        }
        const requeued = infra !== null && infra !== undefined && (infra as { retryable?: unknown }).retryable === true;
        this.#ok(res, route, 200, { ok: true, requeued, attempt: 1 });
        return;
      }
      default: {
        this.#error(res, 404, "NOT_FOUND", `the fake plane has no answer for ${route.descriptor.operationId}`);
      }
    }
  }

  #expectedToken(route: CompiledRoute): string {
    switch (route.descriptor.credential) {
      case "bootstrap":
        return FAKE_BOOTSTRAP_TOKEN;
      case "worker":
        return FAKE_WORKER_TOKEN;
      case "run":
        return FAKE_RUN_TOKEN;
    }
  }

  #params(route: CompiledRoute, path: string): Record<string, string | undefined> {
    const match = route.pattern.exec(path);
    const params: Record<string, string | undefined> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = match?.[index + 1];
    });
    return params;
  }

  /** Answers only what the descriptor says this status may carry — a lying fake proves nothing. */
  #ok(res: ServerResponse, route: CompiledRoute, status: number, payload: unknown): void {
    const schema = route.descriptor.responses[status];
    const checked = schema?.safeParse(payload);
    if (checked !== undefined && !checked.success) {
      this.#send(res, 500, {
        code: "FAKE_PLANE_BROKEN",
        message: `${route.descriptor.operationId} answered a ${status} its own contract rejects: ${checked.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        requestId: randomUUID(),
      });
      return;
    }
    this.#send(res, status, payload);
  }

  #error(res: ServerResponse, status: number, code: string, message: string, issues?: readonly string[]): void {
    this.#send(res, status, {
      code,
      message,
      requestId: randomUUID(),
      ...(issues === undefined ? {} : { issues }),
    });
  }

  #send(res: ServerResponse, status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): void {
    if (status === 204 || payload === null) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }
}
