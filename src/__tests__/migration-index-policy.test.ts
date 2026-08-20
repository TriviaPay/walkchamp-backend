import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Audit 2026-08-17 F-14: a plain CREATE INDEX in a startup migration takes an exclusive lock on
// the table for the whole build — on a hot table that blocks writes and can blow the 120s
// deploy healthcheck window. Hot-table indexes belong in db/concurrent-indexes.sql, applied by
// deploy/coolify/ensure-concurrent-indexes.sh (background, autocommit, CONCURRENTLY).

// Tables that are hot at runtime (unbounded growth and/or on the request path).
const HOT_TABLES = [
  "step_daily_totals",
  "race_participants",
  "race_rooms",
  "wallet_transactions",
  "auth_sessions",
  "profiles",
  "reconciled_steps",
];

// Migrations up to and including 0031 shipped before this policy, while the tables were
// launch-size, and are already applied — applied history is never rewritten.
const GRANDFATHERED_THROUGH = 31;

describe("hot-table index policy (F-14)", () => {
  it("no migration after 0031 creates a non-CONCURRENT index on a hot table", () => {
    const offenders: string[] = [];
    for (const file of readdirSync("db/migrations").filter((f) => f.endsWith(".sql"))) {
      const num = Number.parseInt(file.slice(0, 4), 10);
      if (!Number.isFinite(num) || num <= GRANDFATHERED_THROUGH) continue;

      const sql = readFileSync(`db/migrations/${file}`, "utf8");
      for (const stmt of sql.split(";")) {
        if (!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)) continue;
        if (/CONCURRENTLY/i.test(stmt)) continue; // illegal in migrations anyway, but not this rule
        const target = HOT_TABLES.find((t) => new RegExp(`ON\\s+"?${t}"?\\b`, "i").test(stmt));
        if (target) offenders.push(`${file}: plain CREATE INDEX on hot table "${target}"`);
      }
    }
    // Move the statement to db/concurrent-indexes.sql instead (see db/migrations/README.md).
    expect(offenders).toEqual([]);
  });

  it("every managed concurrent-index statement matches the form the runner can parse", () => {
    const sql = readFileSync("db/concurrent-indexes.sql", "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => /^\s*CREATE/i.test(line));
    for (const stmt of statements) {
      // The runner extracts the quoted name from exactly this shape to clean up INVALID builds.
      expect(stmt).toMatch(/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS "[a-z0-9_]+" ON /);
    }
  });

  it("the runner is wired into the api entrypoint and shipped in the image", () => {
    const entrypoint = readFileSync("deploy/coolify/api-entrypoint.sh", "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    const migrations = entrypoint.indexOf("/usr/local/bin/run-migrations");
    const indexes = entrypoint.indexOf("/usr/local/bin/ensure-concurrent-indexes &");
    expect(migrations).toBeGreaterThan(-1);
    // Runs after migrations (the table must exist) and backgrounded (never blocks the boot).
    expect(indexes).toBeGreaterThan(migrations);

    expect(dockerfile).toContain("deploy/coolify/ensure-concurrent-indexes.sh");
  });
});
