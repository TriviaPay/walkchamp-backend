import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { config } from "../../src/lib/config.js";
import { logger } from "../../src/lib/logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.runtimeUrl,
  max: config.database.poolMax,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  statement_timeout: config.database.statementTimeoutMillis,
  idle_in_transaction_session_timeout: config.database.idleInTransactionSessionTimeoutMillis,
  application_name: `walkchamp-${config.processRole}`,
});

// LOAD-BEARING: node-postgres emits an asynchronous 'error' event on the pool when an *idle*
// pooled client's connection is dropped/recycled by the server (e.g. Neon serverless recycling
// idle connections, or a network blip). With no listener, Node re-throws it as an
// uncaughtException and the whole process dies — this caused the 2026-07-23 outage. Absorbing it
// here keeps a transient DB hiccup non-fatal; the dead client is discarded and the pool creates a
// fresh one on the next query. Do NOT remove (enforced by resilience-guards.test.ts).
pool.on("error", (err) => {
  logger.error({ err }, "[pg] idle client pool error (non-fatal)");
});

export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
