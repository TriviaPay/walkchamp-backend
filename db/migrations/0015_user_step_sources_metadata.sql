ALTER TABLE "user_step_sources"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb;

UPDATE "user_step_sources"
SET "metadata" = '{}'::jsonb
WHERE "metadata" IS NULL;
