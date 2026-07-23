// Process-level safety net. Known external-dependency errors (pg pool, redis, BullMQ) are handled
// at their source and never reach here. This module is the LAST RESORT for genuinely-unanticipated
// faults, plus clean signal-driven shutdown.
//
// Policy (see 2026-07-23 outage RCA):
// - unhandledRejection -> log, DO NOT exit (a stray rejection must not take down the server).
// - uncaughtException  -> log FATAL, graceful shutdown, exit(1) so the orchestrator restarts a
//   CLEAN process (never keep serving a payments/wallet app from a possibly-corrupted state).
// - SIGTERM/SIGINT      -> graceful shutdown, exit(0).
//
// Enforced by resilience-guards.test.ts — do not remove the handler registrations.

type MinimalLogger = {
  error: (obj: unknown, msg?: string) => void;
  fatal: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
};

export interface ProcessSafetyOptions {
  logger: MinimalLogger;
  /** Best-effort cleanup (close server, pg pool, queues). Should not throw; errors are logged. */
  onShutdown?: () => Promise<void>;
  /** Hard cap on shutdown before forcing exit, so a stuck close can't hang the pod. */
  shutdownTimeoutMs?: number;
  /** Injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injectable event target for tests. Defaults to `process`. */
  target?: NodeJS.EventEmitter;
}

export interface ProcessSafetyControls {
  gracefulShutdown: (reason: string, code: number) => Promise<void>;
}

export function installProcessSafetyHandlers(opts: ProcessSafetyOptions): ProcessSafetyControls {
  const { logger, onShutdown, shutdownTimeoutMs = 10_000 } = opts;
  const target: NodeJS.EventEmitter = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  async function gracefulShutdown(reason: string, code: number): Promise<void> {
    if (shuttingDown) return; // idempotent: ignore concurrent signals / re-entry
    shuttingDown = true;
    logger.info({ reason, code }, "[processSafety] graceful shutdown starting");

    const timer = setTimeout(() => {
      logger.error({ reason }, "[processSafety] shutdown timed out; forcing exit");
      exit(code);
    }, shutdownTimeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    try {
      if (onShutdown) await onShutdown();
    } catch (err) {
      logger.error({ err, reason }, "[processSafety] error during shutdown");
    } finally {
      clearTimeout(timer);
      exit(code);
    }
  }

  target.on("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason }, "[processSafety] unhandledRejection (non-fatal)");
  });

  target.on("uncaughtException", (err: unknown) => {
    logger.fatal({ err }, "[processSafety] uncaughtException — restarting");
    void gracefulShutdown("uncaughtException", 1);
  });

  target.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM", 0);
  });
  target.on("SIGINT", () => {
    void gracefulShutdown("SIGINT", 0);
  });

  return { gracefulShutdown };
}
