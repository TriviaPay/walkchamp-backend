-- Hot-table index builds (audit 2026-08-17 F-14).
--
-- Statements here run via deploy/coolify/ensure-concurrent-indexes.sh: AFTER drizzle
-- migrations, in the BACKGROUND (they never extend the deploy healthcheck window), and in
-- psql autocommit mode (CONCURRENTLY is illegal inside the transaction drizzle wraps around
-- every migration file).
--
-- Rules — enforced by src/__tests__/migration-index-policy.test.ts:
--   * Every statement must be exactly of the form:
--       CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "<index_name>" ON ...;
--     (the runner parses index names in that shape to clean up INVALID leftovers)
--   * New indexes on hot tables (step_daily_totals, race_participants, race_rooms,
--     wallet_transactions, auth_sessions, profiles, reconciled_steps) belong HERE, never as
--     a plain CREATE INDEX in a numbered migration — a non-concurrent build takes an
--     exclusive lock and blocks writes for the duration.
--   * A failed CONCURRENTLY build leaves an INVALID index; the runner drops invalid managed
--     indexes on the next boot and retries, so a one-off failure self-heals.
--
-- The session ingest key is additive and nullable; existing rows therefore cannot conflict
-- while this unique index is built in production.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "step_sessions_ingest_session_key_idx" ON "step_sessions" ("ingest_session_key");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "race_participants_user_room_idx" ON "race_participants" ("user_id", "race_room_id");
