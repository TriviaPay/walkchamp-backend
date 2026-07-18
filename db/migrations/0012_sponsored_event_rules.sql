UPDATE "race_rooms"
SET
  "target_steps" = 10000,
  "updated_at" = now()
WHERE
  "type" = 'sponsored'
  AND "status" IN ('scheduled', 'in_progress')
  AND "target_steps" <> 10000;
