UPDATE "profiles"
SET "country_code" = upper(trim("country_code"))
WHERE "country_code" IS NOT NULL
  AND "country_code" <> upper(trim("country_code"));
--> statement-breakpoint

UPDATE "race_results" rr
SET "eligible_for_prize" = true
FROM "race_rooms" rm
WHERE rr."race_room_id" = rm."id"::text
  AND rm."starting_participant_count" IS NULL
  AND rr."eligible_for_prize" = false
  AND EXISTS (
    SELECT 1
    FROM "coin_reward_grants" crg
    WHERE crg."user_id" = rr."user_id"
      AND crg."source_id" = rr."race_room_id"
      AND (
        crg."reward_code" LIKE '%\_RACE\_WIN\_%' ESCAPE '\'
        OR crg."reward_code" IN ('PUBLIC_ROOM_WIN', 'PRIVATE_ROOM_WIN')
      )
  );
--> statement-breakpoint

UPDATE "walking_group_daily_steps" wgds
SET
  "daily_steps" = sdt."steps",
  "verified_steps" = CASE WHEN sdt."source_class" = 'verified' THEN sdt."steps" ELSE 0 END,
  "calories" = sdt."calories_burned",
  "distance_meters" = sdt."distance_meters",
  "last_synced_at" = now(),
  "updated_at" = now()
FROM "step_daily_totals" sdt
WHERE sdt."user_id" = wgds."user_id"
  AND sdt."date" = wgds."step_date";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "step_daily_totals_date_user_steps_idx"
ON "step_daily_totals" USING btree ("date", "user_id") INCLUDE ("steps");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "profiles_country_code_norm_idx"
ON "profiles" USING btree (upper(trim("country_code")));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "profiles_active_total_steps_idx"
ON "profiles" USING btree ("total_steps" DESC)
WHERE "account_status" NOT IN ('banned', 'deleted');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "race_results_user_eligible_prize_idx"
ON "race_results" USING btree ("user_id")
WHERE "eligible_for_prize" = true;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "coin_transactions_user_reward_code_idx"
ON "coin_transactions" USING btree ("user_id")
WHERE "reward_code" IS NOT NULL;
