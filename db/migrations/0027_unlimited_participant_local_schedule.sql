-- ══════════════════════════════════════════════════════════════════════════════
-- Unlimited Daily Goal Challenge: per-participant local-midnight scheduling.
--
-- Before this migration the schedule was ONE UTC instant (unlimited_challenges.start_at_utc).
-- Day windows were derived by projecting that instant into each participant's zone, which shifts
-- Day 1 by a calendar day for anyone EAST of the challenge timezone, and made everyone "start"
-- at the host's instant regardless of their own local midnight.
--
-- The schedule is now a CALENDAR DATE (start_local_date). Every participant starts at 00:00 on
-- that date in their own locked timezone.
--
-- Additive and backward-compatible: every new column is nullable or defaulted, no column is
-- dropped, and start_at_utc / challenge_end_at_utc keep their existing meaning for ordering,
-- listings and legacy clients.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Challenge-level semantic schedule ────────────────────────────────────
ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "start_local_date" date;--> statement-breakpoint
ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "start_local_time" text DEFAULT '00:00' NOT NULL;--> statement-breakpoint

-- ── 2. Participant-level schedule ───────────────────────────────────────────
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "participant_start_at_utc" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "participant_end_at_utc" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unlimited_participants_challenge_end_idx" ON "unlimited_challenge_participants" USING btree ("challenge_id","participant_end_at_utc");--> statement-breakpoint

-- ── 3. Backfill start_local_date for existing challenges ────────────────────
-- Reconstructs the date the host actually picked: the local calendar date of start_at_utc in the
-- challenge timezone. This is exact — start_at_utc was validated to be local midnight in that
-- zone at creation, so no timezone history is invented here.
--
-- challenge_timezone is nullable on rows created before it existed. Those fall back to the UTC
-- calendar date, which is the same value the old code would have produced for a UTC-anchored
-- challenge; it is recorded rather than guessed at, and such rows are listed by the audit query
-- at the end of this file.
UPDATE "unlimited_challenges"
SET "start_local_date" = ("start_at_utc" AT TIME ZONE COALESCE("challenge_timezone", 'UTC'))::date
WHERE "start_local_date" IS NULL;--> statement-breakpoint

-- ── 4. Backfill participant schedules ───────────────────────────────────────
-- IMPORTANT: existing ACTIVE challenges are NOT reinterpreted. Their day rows in
-- unlimited_challenge_days already exist with concrete window_start_utc / window_end_utc, and
-- those rows stay exactly as they are — re-deriving them under the new rule would move a running
-- participant's day boundaries mid-challenge and could retroactively pass or fail a day.
--
-- So the backfill takes the participant's schedule FROM their existing day rows wherever they
-- exist (authoritative, already lived-through), and only computes it from start_local_date for
-- participants who have no day rows yet (challenge has not started).
UPDATE "unlimited_challenge_participants" AS p
SET "participant_start_at_utc" = d."min_start",
    "participant_end_at_utc" = d."max_end"
FROM (
  SELECT "participant_id", MIN("window_start_utc") AS "min_start", MAX("window_end_utc") AS "max_end"
  FROM "unlimited_challenge_days"
  GROUP BY "participant_id"
) AS d
WHERE d."participant_id" = p."id"
  AND p."participant_start_at_utc" IS NULL;--> statement-breakpoint

-- Participants with no materialized days yet (challenge still waiting): derive from the semantic
-- date in their own locked timezone. `AT TIME ZONE tz` applied to a naive timestamp yields the UTC
-- instant of that wall time in tz, and Postgres resolves DST using the same IANA rules the
-- application uses.
UPDATE "unlimited_challenge_participants" AS p
SET "participant_start_at_utc" =
      (c."start_local_date"::timestamp) AT TIME ZONE p."participant_timezone",
    "participant_end_at_utc" =
      ((c."start_local_date"::timestamp + make_interval(days => c."duration_days"))) AT TIME ZONE p."participant_timezone"
FROM "unlimited_challenges" AS c
WHERE c."id" = p."challenge_id"
  AND p."participant_start_at_utc" IS NULL
  AND c."start_local_date" IS NOT NULL;--> statement-breakpoint

-- ── 5. Audit trail for rows that could not be reconstructed exactly ─────────
-- Any challenge that had no challenge_timezone had its start_local_date inferred as the UTC date.
-- Recorded, not silently accepted, so ops can review before those challenges settle.
INSERT INTO "audit_logs" ("actor_type", "action", "entity_type", "entity_id", "reason", "metadata")
SELECT
  'system',
  'unlimited_challenge.local_schedule_backfill_uncertain',
  'unlimited_challenge',
  c."id",
  'challenge_timezone was null; start_local_date inferred from the UTC calendar date',
  jsonb_build_object(
    'startAtUtc', c."start_at_utc",
    'inferredStartLocalDate', c."start_local_date",
    'status', c."status",
    'durationDays', c."duration_days"
  )
FROM "unlimited_challenges" AS c
WHERE c."challenge_timezone" IS NULL
  AND c."status" NOT IN ('completed', 'cancelled_by_platform');
