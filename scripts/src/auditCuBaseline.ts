import { pool } from "../../db/src/index.js";

async function main() {
  const database = await pool.query(`
    SELECT now() AS captured_at, datname, numbackends, xact_commit, xact_rollback,
      blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
      conflicts, temp_bytes, deadlocks
    FROM pg_stat_database WHERE datname = current_database()
  `);
  let statements: unknown[] = [];
  try {
    const result = await pool.query(`
      SELECT queryid::text, calls, total_exec_time, mean_exec_time, rows,
        shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written,
        wal_records, wal_bytes::text, left(regexp_replace(query, '\\s+', ' ', 'g'), 500) AS query
      FROM pg_stat_statements
      ORDER BY total_exec_time DESC
      LIMIT 100
    `);
    statements = result.rows;
  } catch (error) {
    statements = [{ warning: "pg_stat_statements is unavailable", error: String(error) }];
  }
  process.stdout.write(`${JSON.stringify({ database: database.rows[0] ?? null, statements }, null, 2)}\n`);
}

main().finally(() => pool.end()).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
