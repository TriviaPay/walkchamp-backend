UPDATE "unlimited_challenge_participants" p
SET
  "qualification_status" = 'active',
  "disqualified_at" = NULL,
  "disqualification_reason" = NULL,
  "prize_pool_eligibility_status" = 'not_eligible',
  "eligibility_reason_code" = 'daily_goal_missed',
  "eligibility_finalized_at" = COALESCE(p."eligibility_finalized_at", p."disqualified_at", now()),
  "updated_at" = now()
FROM "unlimited_challenges" c
WHERE c."id" = p."challenge_id"
  AND c."status" IN ('waiting', 'starting', 'active', 'settling')
  AND p."qualification_status" = 'disqualified'
  AND p."disqualification_reason" = 'missed_daily_goal';
--> statement-breakpoint
