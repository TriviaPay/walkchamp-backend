CREATE TABLE IF NOT EXISTS "race_participants_repair_audit" AS
SELECT
  rp.*,
  CAST(NULL AS text) AS "audit_reason",
  CAST(NULL AS timestamp) AS "archived_at"
FROM "race_participants" rp
WHERE false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_registrations_repair_audit" AS
SELECT
  srr.*,
  CAST(NULL AS text) AS "audit_reason",
  CAST(NULL AS timestamp) AS "archived_at"
FROM "scheduled_room_registrations" srr
WHERE false;
--> statement-breakpoint
WITH duplicate_race_participants AS (
  SELECT rp.*
  FROM "race_participants" rp
  INNER JOIN (
    SELECT "race_room_id", "user_id"
    FROM "race_participants"
    GROUP BY "race_room_id", "user_id"
    HAVING count(*) > 1
  ) dup
    ON dup."race_room_id" = rp."race_room_id"
   AND dup."user_id" = rp."user_id"
)
INSERT INTO "race_participants_repair_audit"
SELECT
  dup.*,
  'pre_dedupe_duplicate_group' AS "audit_reason",
  now() AS "archived_at"
FROM duplicate_race_participants dup;
--> statement-breakpoint
WITH duplicate_scheduled_registrations AS (
  SELECT srr.*
  FROM "scheduled_room_registrations" srr
  INNER JOIN (
    SELECT "race_room_id", "user_id"
    FROM "scheduled_room_registrations"
    GROUP BY "race_room_id", "user_id"
    HAVING count(*) > 1
  ) dup
    ON dup."race_room_id" = srr."race_room_id"
   AND dup."user_id" = srr."user_id"
)
INSERT INTO "scheduled_registrations_repair_audit"
SELECT
  dup.*,
  'pre_dedupe_duplicate_group' AS "audit_reason",
  now() AS "archived_at"
FROM duplicate_scheduled_registrations dup;
--> statement-breakpoint
WITH ranked_race_participants AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY "race_room_id", "user_id"
      ORDER BY
        CASE
          WHEN "status" IN ('joined', 'active') THEN 0
          WHEN "status" = 'left' THEN 1
          WHEN "status" = 'completed' THEN 2
          ELSE 3
        END,
        COALESCE("completed_at", "finished_at", "joined_at") DESC,
        "joined_at" DESC,
        "id" DESC
    ) AS rn
  FROM "race_participants"
)
DELETE FROM "race_participants" rp
USING ranked_race_participants ranked
WHERE rp.ctid = ranked.ctid
  AND ranked.rn > 1;
--> statement-breakpoint
WITH ranked_scheduled_registrations AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY "race_room_id", "user_id"
      ORDER BY
        CASE WHEN "status" <> 'cancelled' THEN 0 ELSE 1 END,
        COALESCE("activated_at", "registered_at", "cancelled_at") DESC,
        "registered_at" DESC,
        "id" DESC
    ) AS rn
  FROM "scheduled_room_registrations"
)
DELETE FROM "scheduled_room_registrations" srr
USING ranked_scheduled_registrations ranked
WHERE srr.ctid = ranked.ctid
  AND ranked.rn > 1;
--> statement-breakpoint
UPDATE "race_rooms" rr
SET
  "current_players" = counts.current_players,
  "registered_count" = counts.registered_count,
  "updated_at" = now()
FROM (
  SELECT
    room_ids."id",
    COALESCE(participants.current_players, 0) AS current_players,
    COALESCE(registrations.registered_count, 0) AS registered_count
  FROM "race_rooms" room_ids
  LEFT JOIN (
    SELECT
      "race_room_id",
      count(DISTINCT "user_id")::int AS current_players
    FROM "race_participants"
    WHERE "status" <> 'left'
    GROUP BY "race_room_id"
  ) participants
    ON participants."race_room_id" = room_ids."id"
  LEFT JOIN (
    SELECT
      "race_room_id",
      count(DISTINCT "user_id")::int AS registered_count
    FROM "scheduled_room_registrations"
    WHERE "status" IN ('registered', 'active', 'activated')
    GROUP BY "race_room_id"
  ) registrations
    ON registrations."race_room_id" = room_ids."id"
) counts
WHERE rr."id" = counts."id";
--> statement-breakpoint
UPDATE "profiles"
SET
  "profile_completed" = true,
  "updated_at" = now()
WHERE "profile_completed" = false
  AND COALESCE("email", '') <> ''
  AND COALESCE("full_name", '') <> ''
  AND COALESCE("username", '') <> ''
  AND COALESCE("date_of_birth", '') <> ''
  AND COALESCE("country", '') <> ''
  AND COALESCE("country_code", '') <> ''
  AND COALESCE("country_flag", '') <> ''
  AND "terms_accepted" = true
  AND "privacy_accepted" = true
  AND "reward_disclaimer_accepted" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_transactions_provider_order_unique_idx"
ON "deposit_transactions" USING btree ("provider", "provider_order_id")
WHERE "provider_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_participants_room_user_unique_idx"
ON "race_participants" USING btree ("race_room_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_registrations_room_user_unique_idx"
ON "scheduled_room_registrations" USING btree ("race_room_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_participants_finish_rank_unique_idx"
ON "race_participants" USING btree ("race_room_id", "finish_rank")
WHERE "finish_rank" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_payment_unique_idx"
ON "promo_redemptions" USING btree ("payment_id")
WHERE "payment_id" IS NOT NULL;
