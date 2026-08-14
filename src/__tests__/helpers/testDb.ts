import { execFileSync, type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../../db/src/schema/index.js";

const { Pool } = pg;

export type TestDatabase = {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
  connectionString: string;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

type LocalPostgres = {
  connectionString: string;
  dataDir: string;
  process: ChildProcess;
};

const ENABLED = process.env.VITEST_DB === "1";
const EXTERNAL_URL = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_TEST_URL?.trim();
const USE_LOCAL_POSTGRES = process.env.VITEST_DB_LOCAL_POSTGRES === "1";

function hasBinary(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function canRunTestDb(): boolean {
  if (!ENABLED) return false;
  if (EXTERNAL_URL) return true;
  if (!USE_LOCAL_POSTGRES) return false;
  return hasBinary("initdb") && hasBinary("postgres");
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

function assertSafeExternalTestDatabaseUrl(connectionString: string): void {
  const allowUnsafe = process.env.ALLOW_UNSAFE_TEST_DB === "1";
  const parsed = new URL(connectionString);
  const host = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!allowUnsafe && !localHosts.has(host) && process.env.ALLOW_NONLOCAL_TEST_DB !== "1") {
    throw new Error("TEST_DATABASE_URL must point at localhost unless ALLOW_NONLOCAL_TEST_DB=1 is set.");
  }

  if (!allowUnsafe && !/(^|[_-])(test|vitest|tmp|ephemeral)([_-]|$)/i.test(database)) {
    throw new Error("TEST_DATABASE_URL database name must include test, vitest, tmp, or ephemeral.");
  }

  const redFlags = `${host} ${database}`.toLowerCase();
  if (!allowUnsafe && /(neon|prod|production|coolify|miragaming|walkchamp-backend)/.test(redFlags)) {
    throw new Error("TEST_DATABASE_URL looks like a production or hosted database URL.");
  }
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw new Error("ephemeral postgres did not start");
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
}

async function startLocalPostgres(): Promise<LocalPostgres> {
  if (!hasBinary("initdb") || !hasBinary("postgres")) {
    throw new Error("VITEST_DB_LOCAL_POSTGRES=1 requires local initdb/postgres binaries.");
  }

  const dataDir = mkdtempSync(join(tmpdir(), "walkchamp-vitest-pg-"));
  const port = 6700 + (process.pid % 500);
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;

  execFileSync("initdb", ["-D", dataDir, "-A", "trust", "-U", "postgres"], { stdio: "ignore" });
  const processHandle = spawn(
    "postgres",
    ["-D", dataDir, "-p", String(port), "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off"],
    { stdio: "ignore" },
  );

  try {
    await waitForPostgres(connectionString);
  } catch (err) {
    processHandle.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  return { connectionString, dataDir, process: processHandle };
}

async function stopLocalPostgres(local: LocalPostgres | undefined): Promise<void> {
  if (!local) return;

  if (!local.process.killed) {
    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(resolveStop, 5_000);
      local.process.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
      local.process.kill("SIGQUIT");
    });
  }

  rmSync(local.dataDir, { recursive: true, force: true });
}

async function resetPublicTables(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ schemaname: string; tablename: string }>(`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY schemaname, tablename
  `);

  if (rows.length === 0) return;

  const tables = rows
    .map((row) => `${quoteIdent(row.schemaname)}.${quoteIdent(row.tablename)}`)
    .join(", ");

  await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

function splitMigrationStatements(migrationSql: string): string[] {
  const statements: string[] = [];
  const enumValuePattern = /ALTER\s+TYPE[\s\S]+?ADD\s+VALUE[\s\S]+?;/i;

  for (const chunk of migrationSql.split("--> statement-breakpoint")) {
    let remaining = chunk.trim();

    while (remaining.length > 0) {
      const enumValueMatch = enumValuePattern.exec(remaining);
      if (!enumValueMatch) {
        statements.push(remaining);
        break;
      }

      const before = remaining.slice(0, enumValueMatch.index).trim();
      if (before) statements.push(before);
      statements.push(enumValueMatch[0].trim());
      remaining = remaining.slice(enumValueMatch.index + enumValueMatch[0].length).trim();
    }
  }

  return statements.filter(Boolean);
}

async function runMigrations(pool: pg.Pool): Promise<void> {
  const migrationsFolder = resolve(process.cwd(), "db/migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ when: number; tag: string }>;
  };
  const journalByTag = new Map(journal.entries.map((entry) => [entry.tag, entry]));

  await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const applied = new Set(
    (await pool.query<{ created_at: string }>(
      "SELECT created_at::text FROM drizzle.__drizzle_migrations",
    )).rows.map((row) => row.created_at),
  );

  const migrationFiles = readdirSync(migrationsFolder)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();

  for (const file of migrationFiles) {
    const tag = file.replace(/\.sql$/, "");
    const journalEntry = journalByTag.get(tag);
    if (!journalEntry) throw new Error(`Missing migration journal entry for ${tag}.`);
    if (applied.has(String(journalEntry.when))) continue;

    const filePath = resolve(migrationsFolder, file);
    const migrationSql = readFileSync(filePath, "utf8");
    const statements = splitMigrationStatements(migrationSql);

    for (const statement of statements) {
      await pool.query(statement);
    }

    const hash = createHash("sha256").update(migrationSql).digest("hex");
    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ($1, $2)`,
      [hash, journalEntry.when],
    );
    applied.add(String(journalEntry.when));
  }
}

export async function setupTestDb(): Promise<TestDatabase> {
  if (!ENABLED) throw new Error("setupTestDb requires VITEST_DB=1.");
  if (!EXTERNAL_URL && !USE_LOCAL_POSTGRES) {
    throw new Error("setupTestDb requires TEST_DATABASE_URL, DATABASE_TEST_URL, or VITEST_DB_LOCAL_POSTGRES=1.");
  }

  let local: LocalPostgres | undefined;
  const connectionString = EXTERNAL_URL ?? (local = await startLocalPostgres()).connectionString;
  if (EXTERNAL_URL) assertSafeExternalTestDatabaseUrl(EXTERNAL_URL);

  const pool = new Pool({ connectionString, max: 4 });
  pool.on("error", () => {});

  const db = drizzle(pool, { schema });
  await runMigrations(pool);
  await resetPublicTables(pool);

  return {
    db,
    pool,
    connectionString,
    reset: () => resetPublicTables(pool),
    close: async () => {
      await pool.end().catch(() => {});
      await stopLocalPostgres(local);
    },
  };
}
