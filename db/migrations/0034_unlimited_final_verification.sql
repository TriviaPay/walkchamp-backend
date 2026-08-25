-- Unlimited/Streak: race-wide final Health verification and recoverable result publication.

ALTER TABLE "unlimited_challenges" ADD COLUMN IF NOT EXISTS "results_announced_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "final_verification_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "final_verification_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "final_verification_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "final_verification_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unlimited_challenge_participants" ADD COLUMN IF NOT EXISTS "final_verification_source" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "unlimited_participants_final_verification_idx"
  ON "unlimited_challenge_participants" ("challenge_id", "in_settlement_population", "final_verification_status");--> statement-breakpoint

-- Migration 0029 could not distinguish a pre-start departure from a post-start forfeit and marked
-- every `left` row outside the population. Repair open challenges from the authoritative timestamps:
-- a departure before started_at_utc is out; a departure at/after start remains in.
UPDATE "unlimited_challenge_participants" AS p
SET "in_settlement_population" = CASE
  WHEN p."left_at" IS NOT NULL
    AND (c."started_at_utc" IS NULL OR p."left_at" < c."started_at_utc") THEN false
  ELSE true
END
FROM "unlimited_challenges" AS c
WHERE c."id" = p."challenge_id"
  AND c."status" IN ('waiting', 'starting', 'active', 'settling');--> statement-breakpoint

-- Reserved identities must not become settlement blockers. Explicit environment-configured IDs
-- are additionally removed by captureSettlementPopulation at every new challenge start.
UPDATE "unlimited_challenge_participants" AS p
SET "in_settlement_population" = false
FROM "profiles" AS profile, "unlimited_challenges" AS c
WHERE profile."id" = p."user_id"
  AND c."id" = p."challenge_id"
  AND c."status" IN ('waiting', 'starting', 'active', 'settling')
  AND (
    lower(profile."username") ~ '^(admin|ghost|system|test)([._+0-9-].*)?$'
    OR lower(split_part(profile."email", '@', 1)) ~ '^(admin|ghost|system|test)([._+0-9-].*)?$'
    OR lower(split_part(profile."email", '@', 2)) IN ('example.com', 'example.test', 'test', 'invalid')
  );--> statement-breakpoint

-- Historical results were already announced before this durability field existed. Do not replay
-- their realtime or push events after deployment.
UPDATE "unlimited_challenges"
SET "results_announced_at" = COALESCE("results_ready_at", "settled_at", "updated_at")
WHERE "results_status" = 'results_ready'
  AND "results_announced_at" IS NULL;--> statement-breakpoint

-- Terminal history predates the new final-verification handshake and must remain readable.
UPDATE "unlimited_challenge_participants" AS p
SET "final_verification_status" = 'completed',
    "final_verification_requested_at" = COALESCE(p."eligibility_finalized_at", p."updated_at"),
    "final_verification_submitted_at" = COALESCE(p."eligibility_finalized_at", p."updated_at"),
    "final_verification_completed_at" = COALESCE(p."eligibility_finalized_at", p."updated_at"),
    "final_verification_source" = 'legacy_settled'
FROM "unlimited_challenges" AS c
WHERE c."id" = p."challenge_id"
  AND c."results_status" = 'results_ready'
  AND p."in_settlement_population" = true;--> statement-breakpoint
