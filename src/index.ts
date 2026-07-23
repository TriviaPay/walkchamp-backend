import app from "./app.js";
import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";
import { pool } from "../db/src/index.js";
import { closeQueues } from "./lib/queue.js";
import { installProcessSafetyHandlers } from "./lib/processSafety.js";

// Background startup readiness: warm the pool and surface early warnings if the DB is briefly
// unreachable at boot (e.g. a cold Neon wake). Non-blocking — the server still starts listening
// immediately so liveness/healthz responds fast; lazy queries retry regardless.
async function warmDatabase(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("select 1");
      logger.info({ attempt }, "Database reachable at startup");
      return;
    } catch (err) {
      const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1));
      logger.warn({ err, attempt, delay }, "Database not reachable at startup; retrying");
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.error("Database still unreachable after startup retries; serving anyway (queries will retry)");
}

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, trustProxy: config.trustProxy }, "Server listening");
});

// Actually surface bind/listen errors (the plain listen callback never receives them).
server.on("error", (err) => {
  logger.fatal({ err }, "HTTP server error");
  process.exit(1);
});

// Install the last-resort safety net + graceful shutdown. Known dependency errors are handled at
// their source (db pool, redis, BullMQ) and never reach the uncaughtException path.
installProcessSafetyHandlers({
  logger,
  onShutdown: async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await closeQueues();
    } catch (err) {
      logger.error({ err }, "[shutdown] closeQueues failed");
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, "[shutdown] pool.end failed");
    }
  },
});

void warmDatabase();
