import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

function loadDotEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx < 0) continue;

    const key = line.slice(0, idx).trim();
    if (!key || process.env[key]) continue;

    let value = line.slice(idx + 1);
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));

  const databaseUrl = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("NEON_DATABASE_URL or DATABASE_URL must be set.");
  }

  const journalPath = path.resolve(process.cwd(), "db/migrations/meta/_journal.json");
  const baselineSqlPath = path.resolve(process.cwd(), "db/migrations/0000_baseline.sql");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const baseline = journal.entries.find((entry) => entry.idx === 0);
  if (!baseline) {
    throw new Error("Missing 0000 baseline journal entry.");
  }

  const baselineSql = fs.readFileSync(baselineSqlPath, "utf8");
  const baselineHash = crypto.createHash("sha256").update(baselineSql).digest("hex");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const tableCountResult = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = current_schema()",
    );
    const tableCount = Number(tableCountResult.rows[0]?.count ?? "0");

    if (tableCount === 0) {
      throw new Error("The target database is empty. Run the normal migration flow with `pnpm db:migrate` instead.");
    }

    await client.query("create schema if not exists drizzle");
    await client.query(`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);

    const existingResult = await client.query<{ created_at: string }>(
      "select created_at::text from drizzle.__drizzle_migrations where created_at = $1::bigint limit 1",
      [baseline.when],
    );

    if (existingResult.rows.length > 0) {
      console.log(`Baseline already adopted at created_at=${baseline.when}.`);
      console.log("Next step: run `pnpm db:migrate`.");
      return;
    }

    await client.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       values ($1, $2)`,
      [baselineHash, baseline.when],
    );

    console.log(`Adopted existing database at baseline ${baseline.tag}.`);
    console.log("Next step: run `pnpm db:migrate` to apply post-baseline migrations.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
