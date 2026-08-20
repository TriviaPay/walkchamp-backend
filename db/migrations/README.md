# Migration conventions

Migrations run on **api-container startup** (see `deploy/coolify/api-entrypoint.sh`) inside the
healthcheck window: a failed or slow migration keeps the previous release serving, but a
long-running one can also blow the 120s start period and fail an otherwise good deploy.

## Rules

1. **Additive only.** No `DROP`, no destructive `ALTER`. Rollback is a Coolify redeploy of the
   previous commit; a destructive migration would make that impossible (fix-forward only).
   Every migration through `0031` is additive — keep it that way.

2. **No plain `CREATE INDEX` on hot tables** (audit 2026-08-17 F-14). A non-concurrent index
   build takes an exclusive lock; on a large table (`step_daily_totals`, `race_participants`,
   `wallet_transactions`, `auth_sessions`, ...) that blocks writes and can exceed the deploy
   window. `CREATE INDEX CONCURRENTLY` cannot run in a migration — drizzle wraps each file in
   a transaction — so hot-table indexes go in **`db/concurrent-indexes.sql`** instead:

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "my_new_idx" ON "step_daily_totals" (...);
   ```

   Unique indexes may use `CREATE UNIQUE INDEX CONCURRENTLY` in the same file. The runner accepts
   both forms. `deploy/coolify/ensure-concurrent-indexes.sh` applies that file on every api boot — after
   migrations, in the background (never extends the healthcheck window), autocommit per
   statement, and it drops+retries any INVALID index left by a previously failed build.
   `migration-index-policy.test.ts` fails CI if a migration after `0031` adds a plain
   `CREATE INDEX` on a hot table.

   Small/new tables can keep inline `CREATE INDEX` — the existing inline builds predate this
   rule and were applied while the tables were small; do not rewrite applied migration files
   (their content is part of the applied history).

3. **Never edit an applied migration.** Add a new numbered migration instead.
