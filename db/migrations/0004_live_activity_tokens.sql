CREATE TABLE IF NOT EXISTS "live_activity_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "activity_id" text NOT NULL,
  "platform" text NOT NULL DEFAULT 'ios',
  "push_token" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "live_activity_tokens_race_idx" ON "live_activity_tokens" ("race_id");
CREATE INDEX IF NOT EXISTS "live_activity_tokens_user_idx" ON "live_activity_tokens" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_race_user_active_idx" ON "live_activity_tokens" ("race_id", "user_id");
