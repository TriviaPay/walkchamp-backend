/**
 * Behavioral proof of the process-safety net (reproduces the 2026-07-23 outage trigger and proves
 * it is now non-fatal). Uses an injected EventEmitter target + stubbed exit so the real process is
 * never touched.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { installProcessSafetyHandlers } from "../lib/processSafety";

function setup(onShutdown?: () => Promise<void>, shutdownTimeoutMs = 50) {
  const target = new EventEmitter();
  const logger = { error: vi.fn(), fatal: vi.fn(), info: vi.fn() };
  const exit = vi.fn();
  const controls = installProcessSafetyHandlers({ logger, exit, target, onShutdown, shutdownTimeoutMs });
  return { target, logger, exit, controls };
}

describe("processSafety", () => {
  it("unhandledRejection logs and does NOT exit (a stray rejection can't kill the server)", () => {
    const { target, logger, exit } = setup();
    target.emit("unhandledRejection", new Error("simulated idle pool reset surfaced as rejection"));
    expect(logger.error).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("uncaughtException logs FATAL, runs graceful shutdown, exits 1 (clean restart)", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const { target, logger, exit } = setup(onShutdown);
    target.emit("uncaughtException", new Error("unknown fault"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logger.fatal).toHaveBeenCalled();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("SIGTERM triggers graceful shutdown and exit 0", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const { target, exit } = setup(onShutdown);
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("graceful shutdown is idempotent (concurrent signals -> one cleanup)", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const { controls } = setup(onShutdown);
    await Promise.all([
      controls.gracefulShutdown("SIGTERM", 0),
      controls.gracefulShutdown("SIGINT", 0),
    ]);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("forces exit if cleanup hangs past the timeout (pod can't wedge)", async () => {
    const onShutdown = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const { target, exit } = setup(onShutdown, 30);
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 500 });
  });
});
