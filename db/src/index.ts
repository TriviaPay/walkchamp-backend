import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { config } from "../../src/lib/config.js";

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
export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
