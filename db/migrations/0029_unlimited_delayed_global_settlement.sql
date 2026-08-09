-- ══════════════════════════════════════════════════════════════════════════════
-- Unlimited Challenge: delayed global settlement + explicit prize-pool eligibility.
--
-- Participants hold different locked timezones, so their challenge periods end at different UTC
-- instants. A result is only final once EVERY participant in the settlement population has passed
-- their own local end AND every required day has a terminal verification state. These columns make
-- that lifecycle explicit and queryable instead of implied.
--
-- Additive and backward-compatible: every column is defaulted or nullable, nothing is dropped, and
-- existing settlement/qualification columns keep their meaning.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Challenge-level result lifecycle ─────────────────────────────────────
ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "results_status" text DEFAULT 'in_progress' NOT NULL;--> statement-breakpoint
ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "results_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "settlement_population_size" integer;--> statement-breakpoint

-- ── 2. Participant-level prize-pool eligibility ─────────────────────────────
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "prize_pool_eligibility_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "eligibility_reason_code" text;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "eligibility_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "in_settlement_population" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- The reconciler asks "which challenges have an unfinished participant?" every tick.
CREATE INDEX IF NOT EXISTS "unlimited_challenges_results_status_idx" ON "unlimited_challenges" USING btree ("results_status");--> statement-breakpoint

-- ── 3. Backfill: already-settled challenges are results_ready ───────────────
-- A completed challenge has, by definition, passed every participant's local end and finalized
-- every day. Marking it in_progress would make finished history look unfinished.
UPDATE "unlimited_challenges"
SET "results_status" = 'results_ready',
    "results_ready_at" = COALESCE("settled_at", "updated_at")
WHERE "status" IN ('completed', 'cancelled_by_platform');--> statement-breakpoint

-- ── 4. Backfill: eligibility from the outcome already recorded ──────────────
-- Derived from the terminal qualification_status those rows already carry, so no new judgement is
-- made about a past challenge. Rows still running stay 'pending' and are evaluated at settlement.
UPDATE "unlimited_challenge_participants" AS p
SET "prize_pool_eligibility_status" = 'eligible',
    "eligibility_reason_code" = 'all_days_passed',
    "eligibility_finalized_at" = p."updated_at"
WHERE p."qualification_status" = 'qualified'
  AND p."prize_pool_eligibility_status" = 'pending';--> statement-breakpoint

UPDATE "unlimited_challenge_participants" AS p
SET "prize_pool_eligibility_status" = 'not_eligible',
    "eligibility_reason_code" = CASE
      WHEN p."qualification_status" = 'left' THEN 'left_challenge'
      ELSE COALESCE(p."disqualification_reason", 'daily_goal_missed')
    END,
    "eligibility_finalized_at" = p."updated_at"
FROM "unlimited_challenges" AS c
WHERE c."id" = p."challenge_id"
  AND c."status" IN ('completed', 'cancelled_by_platform')
  AND p."qualification_status" IN ('left', 'disqualified')
  AND p."prize_pool_eligibility_status" = 'pending';--> statement-breakpoint

-- ── 5. Settlement population for challenges already running ─────────────────
-- Participants who left are excluded: they hold no qualification and must not hold results open.
UPDATE "unlimited_challenge_participants"
SET "in_settlement_population" = false
WHERE "qualification_status" = 'left';--> statement-breakpoint

UPDATE "unlimited_challenges" AS c
SET "settlement_population_size" = sub."population"
FROM (
  SELECT "challenge_id", count(*)::int AS "population"
  FROM "unlimited_challenge_participants"
  WHERE "in_settlement_population" = true
  GROUP BY "challenge_id"
) AS sub
WHERE sub."challenge_id" = c."id"
  AND c."settlement_population_size" IS NULL;
