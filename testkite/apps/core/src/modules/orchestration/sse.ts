/**
 * Server-sent events for one run — WITHOUT A PLUGIN.
 *
 * Spike 2026-08-29 on Fastify 5.12.1: `reply.hijack()` then write to `reply.raw` is the whole
 * mechanism. Two consequences the implementer must not fight:
 *
 *   1. The hijack BYPASSES the response serializer, so this route cannot go through
 *      `buildHttpApp`'s `registrations` path (that one always ends in `reply.send()`). It is
 *      registered plugin-style, like authoring's routes, with `config: { tk: descriptor }` so
 *      the auth hook still covers it — measured: the onRequest hook runs BEFORE the hijack, so
 *      401 and 404 are still ordinary JSON answers.
 *   2. NOTHING closes the connection for us. `req.raw.on("close")` is where the interval dies;
 *      without it every abandoned tab leaks a timer AND a database query per second, forever.
 *
 * v1 POLLS the database once a second. LISTEN/NOTIFY is faster (measured 0.29-0.94ms end to
 * end) but needs a dedicated LISTEN connection per API instance plus in-process fan-out; that
 * is an M6 upgrade, and the poll is what makes v1 shippable with zero new moving parts.
 *
 * THE ID SPACE. `id:` is `run_ordinal` — the number `recordRunEvent` stamps on an event once,
 * at insert, from a counter on the run. A reconnect sends `Last-Event-ID: <n>` and the poll
 * asks the database for `run_ordinal > n`, so resume is a WHERE clause and not a re-count.
 * `status` and `done` frames carry the CURRENT cursor rather than one of their own, so a client
 * that reconnects right after one of them resumes exactly where the narration stopped.
 *
 * It used to be the ARRAY POSITION of the event in a `(attempt, seq, job_run_id)`-ordered read,
 * and that was wrong on any run with more than one chain — the ordinary case. Every chain
 * restarts `attempt` and `seq` at 1, so the moment a second chain said its first word, its
 * (1, 1) sorted in front of the first chain's (1, 2) and (1, 3): the new event landed at a
 * position the client had already acked and was never sent, while the events above it were
 * renumbered and sent again as if new. An id has to be a property OF THE EVENT, not of the
 * list it happens to be sitting in. Ordinals may skip a number (a replayed `seq` burns one);
 * the loop is `> cursor`, never `cursor + 1`, so a gap costs nothing.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunStatusDto } from "@testkite/contract";
import { withTenant, type TenantContext, type TkDb } from "../kernel/index.js";
import { readRunEvents, type StoredRunEvent } from "./events.js";
import { isRunTerminal, loadRunStatus } from "./run-service.js";

/** How often the run is re-read. One second is the UI's perceived "live". */
export const SSE_POLL_MS = 1_000;
/**
 * A comment frame every 15s. It carries no data — its only job is to make a dead peer (a
 * dropped NAT mapping, a proxy that closed one side quietly) surface as a write error, which
 * is what fires `close` and reclaims the timer.
 */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * Live streams in this process. Exported as a GAUGE: ops reads it to see how many browsers a
 * pod is holding open, and the test suite reads it to prove that walking away from a stream
 * really does clear its timers (a leak that is otherwise invisible until a pod runs out of
 * connections).
 */
let openStreams = 0;
export function activeRunStreamCount(): number {
  return openStreams;
}

/** One SSE frame. `data` is serialized here so every frame goes out through the same escape path. */
function frame(id: number, event: string, data: unknown): string {
  const payload = JSON.stringify(data);
  // A data field must never contain a bare newline: SSE ends a frame on a blank line.
  return `id: ${String(id)}\nevent: ${event}\ndata: ${payload.replace(/\n/g, "")}\n\n`;
}

function toEventFrame(event: StoredRunEvent): string {
  return frame(event.runOrdinal, "run_event", {
    jobRunId: event.jobRunId,
    attempt: event.attempt,
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    receivedAt: event.receivedAt.toISOString(),
  });
}

/**
 * `Last-Event-ID` is client input: anything that is not a non-negative integer means "start
 * from the beginning", never a crash and never a negative cursor that would replay forever.
 */
export function parseLastEventId(header: string | readonly string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** What `setInterval` hands back on this platform — carried around so neither side unwraps it. */
export type IntervalHandle = ReturnType<typeof setInterval>;

export interface RunStreamDeps {
  readonly db: TkDb;
  /** Poll interval override — the production value is `SSE_POLL_MS`; tests keep it as is. */
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  /**
   * The timer itself as a port, defaulting to the real globals. It exists for ONE claim, the
   * one this file's header makes: an abandoned tab must not leave a timer behind. Proving it
   * needs the handles THIS stream created, and `process.getActiveResourcesInfo()` cannot give
   * them — it is a PROCESS-WIDE count, and vitest runs the whole suite in a single fork, so any
   * unrelated timer that happens to die between two readings shows up as this stream's leak.
   * That is not a hypothesis: two CI runs (33393369459, 33395811296) failed with `expected 1 to
   * be 2` on commits that changed only markdown. Counting stand-ins passed in here make the
   * measurement local to the stream under test and therefore deterministic.
   */
  readonly setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle;
  readonly clearIntervalFn?: (handle: IntervalHandle) => void;
}

/**
 * Streams one run until it reaches a verdict or the client leaves. The caller MUST already have
 * established that `runId` is visible to `ctx` — after the hijack there is no way to send a 404
 * body, so the visibility check cannot live in here.
 */
export function streamRun(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: TenantContext,
  runId: string,
  deps: RunStreamDeps,
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers text/* by default and would hold every frame until the run ends.
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": stream open\n\n");

  let cursor = parseLastEventId(req.headers["last-event-id"]);
  let lastStatus = "";
  let alive = true;
  // A poll that outlasts its interval must not be joined by the next one: both would read the
  // same `cursor` and write the same frames twice.
  let polling = false;
  openStreams += 1;

  const setEvery = deps.setIntervalFn ?? setInterval;
  const clearEvery = deps.clearIntervalFn ?? clearInterval;
  const timer = setEvery(() => {
    void tick();
  }, deps.pollMs ?? SSE_POLL_MS);
  const beat = setEvery(() => {
    if (alive) reply.raw.write(": ping\n\n");
  }, deps.heartbeatMs ?? SSE_HEARTBEAT_MS);

  const close = (): void => {
    if (!alive) return;
    // Order matters: the timers go first, so `activeRunStreamCount() === 0` is a promise that
    // nothing is left holding the event loop.
    alive = false;
    clearEvery(timer);
    clearEvery(beat);
    openStreams -= 1;
    reply.raw.end();
  };

  // The client walking away is the ONLY thing that reclaims a stream over a run that never
  // finishes. `error` is here too: a broken pipe never fires `close` on some proxies.
  req.raw.on("close", close);
  req.raw.on("error", close);
  reply.raw.on("error", close);

  async function tick(): Promise<void> {
    if (!alive || polling) return;
    polling = true;
    try {
      // The cursor is read INTO the query, so a poll only ever carries back what this client
      // has not seen — the resume rule and the live rule are one statement, not two.
      const since = cursor;
      const { run, events } = await withTenant(deps.db, ctx, async (tx) => {
        const status = await loadRunStatus(tx, ctx, runId);
        if (status === undefined) return { run: undefined, events: [] as readonly StoredRunEvent[] };
        return { run: status, events: await readRunEvents(tx, ctx, { runId, afterOrdinal: since }) };
      });
      if (!alive) return;
      // The run vanished under the stream (a team purge). Nothing left to narrate.
      if (run === undefined) {
        close();
        return;
      }
      for (const event of events) {
        reply.raw.write(toEventFrame(event));
        cursor = Math.max(cursor, event.runOrdinal);
      }

      // Only when it CHANGED: a status frame every second would drown the narration and make
      // the heartbeat pointless.
      const serialized = JSON.stringify(run);
      if (serialized !== lastStatus) {
        lastStatus = serialized;
        reply.raw.write(frame(cursor, "status", run));
      }
      if (isRunTerminal(run)) {
        reply.raw.write(frame(cursor, "done", doneOf(run)));
        close();
      }
    } catch (err) {
      req.log.error({ err, runId }, "run stream poll failed");
      close();
    } finally {
      polling = false;
    }
  }

  // The first read happens NOW, not one poll interval from now: a run that is already finished
  // must answer and close immediately instead of holding a socket open for a second.
  void tick();
}

function doneOf(run: RunStatusDto): Readonly<Record<string, unknown>> {
  return {
    runId: run.runId,
    status: run.status,
    verdict: run.verdict,
    chainTotal: run.chainTotal,
    chainDone: run.chainDone,
  };
}
