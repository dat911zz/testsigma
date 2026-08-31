/**
 * SCOPE — what this file can and cannot prove.
 *
 * The client here is a STUB, so this suite proves ORDER, PAYLOAD SHAPE and the drain state
 * machine: register happens once and before the first heartbeat, the heartbeat body is the one
 * `workerHeartbeatRequestSchema` describes, drain is a one-way door, and a control plane that is
 * down cannot take the daemon with it. It proves nothing about the far end — that a real plane
 * accepts these bodies is `apps/core`'s internal-plane suites, and that a real host's PSI moves
 * is `test/host/psi.test.ts` under `test:host`.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  RegisterRequest,
  RegisterResponse,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
} from "../../src/control-plane-client.js";
import { Runnerd, type RunnerdClient } from "../../src/runnerd/daemon.js";

interface FakePlaneOptions {
  readonly command?: "continue" | "drain";
  readonly drainAtRegister?: boolean;
  readonly heartbeatIntervalMs?: number;
  /** `null` is what the plane answers when the roster row was gone — nothing was renewed. */
  readonly workerTokenRenewedAt?: string | null;
}

function client(options: FakePlaneOptions = {}): RunnerdClient {
  return {
    register: vi.fn(
      async (req: RegisterRequest): Promise<RegisterResponse> => ({
        workerId: req.workerId,
        lane: req.lane,
        workerToken: "tkw_fake_worker",
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5_000,
        drain: options.drainAtRegister ?? false,
      }),
    ),
    workerHeartbeat: vi.fn(
      async (_req: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse> => ({
        command: options.command ?? "continue",
        // `??` would be wrong here: `null` is the answer under test, not an absent option.
        workerTokenRenewedAt:
          options.workerTokenRenewedAt === undefined ? "2026-08-31T00:00:00.000Z" : options.workerTokenRenewedAt,
      }),
    ),
  };
}

const base = {
  workerId: "host1-runnerd",
  hostname: "host1",
  lane: "batch" as const,
  capacity: 4,
  readPsiSample: () => null,
  selfRssBytes: () => 95_000_000,
  busySlots: () => 2,
  onDrain: () => {},
  log: () => {},
};

describe("Runnerd", () => {
  it("registers once before its first heartbeat", async () => {
    const c = client();
    const d = new Runnerd({ ...base, client: c });
    await d.heartbeatOnce();
    await d.heartbeatOnce();
    expect(c.register).toHaveBeenCalledTimes(1);
    expect(c.workerHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("registers with the identity, lane and capacity the contract requires", async () => {
    const c = client();
    const d = new Runnerd({ ...base, client: c });
    await d.heartbeatOnce();
    expect(c.register).toHaveBeenCalledWith({
      workerId: "host1-runnerd",
      hostname: "host1",
      lane: "batch",
      capacity: 4,
    });
  });

  it("sends the current PSI and RSS with each heartbeat", async () => {
    const c = client();
    const d = new Runnerd({
      ...base,
      client: c,
      readPsiSample: () => ({ some10: 42.31, some60: 18.02, full10: 12.5 }),
    });
    await d.heartbeatOnce();
    expect(c.workerHeartbeat).toHaveBeenCalledWith({
      freeSlots: 2,
      psi: { some10: 42.31, full10: 12.5 },
      rssBytes: 95_000_000,
    });
  });

  it("OMITS psi entirely on a kernel without pressure data instead of reporting a calm zero", async () => {
    const c = client();
    const d = new Runnerd({ ...base, client: c });
    await d.heartbeatOnce();
    const [sent] = vi.mocked(c.workerHeartbeat).mock.calls[0] ?? [];
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("psi");
  });

  it("reports free slots as capacity minus the busy ones, never a negative number", async () => {
    const c = client();
    const d = new Runnerd({ ...base, client: c, capacity: 4, busySlots: () => 9 });
    await d.heartbeatOnce();
    expect(c.workerHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ freeSlots: 0 }));
  });

  it("fires onDrain when the control plane answers with drain", async () => {
    const onDrain = vi.fn();
    const d = new Runnerd({ ...base, client: client({ command: "drain" }), onDrain });
    expect(await d.heartbeatOnce()).toBe("drain");
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it("fires onDrain only ONCE even if drain keeps being returned", async () => {
    const onDrain = vi.fn();
    const d = new Runnerd({ ...base, client: client({ command: "drain" }), onDrain });
    await d.heartbeatOnce();
    await d.heartbeatOnce();
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it("honours a roster row that was already draining when this daemon registered", async () => {
    const onDrain = vi.fn();
    const d = new Runnerd({ ...base, client: client({ drainAtRegister: true }), onDrain });
    // The heartbeat itself answers "continue"; the registration already said otherwise, and
    // re-registering must not be a way for a machine to un-drain itself.
    expect(await d.heartbeatOnce()).toBe("drain");
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it("stays drained after a later heartbeat answers continue — drain is a one-way door", async () => {
    const plane = client({ command: "drain" });
    const d = new Runnerd({ ...base, client: plane });
    expect(await d.heartbeatOnce()).toBe("drain");
    vi.mocked(plane.workerHeartbeat).mockResolvedValue({
      command: "continue",
      workerTokenRenewedAt: "2026-08-31T00:00:05.000Z",
    });
    expect(await d.heartbeatOnce()).toBe("drain");
  });

  it("exposes the host watermark computed from PSI", async () => {
    const d = new Runnerd({
      ...base,
      client: client(),
      readPsiSample: () => ({ some10: 42.31, some60: 1, full10: 1 }),
    });
    await d.heartbeatOnce();
    expect(d.watermark()).toBe("red");
  });

  it("survives a control plane error without killing the data path", async () => {
    const c: RunnerdClient = {
      register: vi.fn(
        async (req: RegisterRequest): Promise<RegisterResponse> => ({
          workerId: req.workerId,
          lane: req.lane,
          workerToken: "t",
          heartbeatIntervalMs: 5_000,
          drain: false,
        }),
      ),
      workerHeartbeat: vi.fn(async (): Promise<WorkerHeartbeatResponse> => {
        throw new Error("down");
      }),
    };
    const log = vi.fn();
    const d = new Runnerd({ ...base, client: c, log });
    await expect(d.heartbeatOnce()).resolves.toBe("continue");
    expect(log).toHaveBeenCalled();
  });

  it("registers again on the next tick when registration itself failed", async () => {
    const c = client();
    vi.mocked(c.register).mockRejectedValueOnce(new Error("plane down"));
    const d = new Runnerd({ ...base, client: c });
    await d.heartbeatOnce();
    expect(c.workerHeartbeat).not.toHaveBeenCalled();
    await d.heartbeatOnce();
    expect(c.register).toHaveBeenCalledTimes(2);
    expect(c.workerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("says so when the plane renewed nothing, because that means the roster row is gone", async () => {
    const log = vi.fn();
    const d = new Runnerd({
      ...base,
      client: client({ command: "drain", workerTokenRenewedAt: null }),
      log,
    });
    await d.heartbeatOnce();
    expect(log.mock.calls.flat().join(" ")).toContain("roster row");
  });

  describe("scheduling", () => {
    it("heartbeats on the published interval until stop()", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        const d = new Runnerd({ ...base, client: c, intervalMs: 5_000 });
        d.start();
        await vi.advanceTimersByTimeAsync(12_000);
        expect(c.workerHeartbeat).toHaveBeenCalledTimes(2);
        d.stop();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(c.workerHeartbeat).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts the cadence the control plane published rather than its own guess", async () => {
      vi.useFakeTimers();
      try {
        const c = client({ heartbeatIntervalMs: 1_000 });
        const d = new Runnerd({ ...base, client: c, intervalMs: 10_000 });
        d.start();
        // One tick at the local guess is what LEARNS the cadence...
        await vi.advanceTimersByTimeAsync(10_000);
        expect(c.workerHeartbeat).toHaveBeenCalledTimes(1);
        // ...and from then on the plane's second, not the daemon's ten.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(vi.mocked(c.workerHeartbeat).mock.calls.length).toBeGreaterThanOrEqual(5);
        d.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not pile heartbeats up on a slow control plane", async () => {
      vi.useFakeTimers();
      try {
        const c = client();
        let release = (): void => {};
        vi.mocked(c.workerHeartbeat).mockImplementationOnce(
          async () =>
            new Promise<WorkerHeartbeatResponse>((resolve) => {
              release = () => resolve({ command: "continue", workerTokenRenewedAt: null });
            }),
        );
        const d = new Runnerd({ ...base, client: c, intervalMs: 5_000 });
        d.start();
        await vi.advanceTimersByTimeAsync(26_000);
        expect(c.workerHeartbeat).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(c.workerHeartbeat).toHaveBeenCalledTimes(2);
        d.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
