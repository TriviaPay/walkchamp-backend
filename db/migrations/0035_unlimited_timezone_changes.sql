-- Confirmed Streak Challenge timezone changes. Existing day rows remain the source of truth;
-- this table records who confirmed the change, when, and the first challenge day it may affect.
CREATE TABLE IF NOT EXISTS "unlimited_challenge_timezone_changes" (
  "id" text PRIMARY KEY NOT NULL,
  "challenge_id" text NOT NULL,
  "participant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "previous_timezone" text NOT NULL,
  "new_timezone" text NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "effective_challenge_day" integer NOT NULL,
  "applies_to_challenge" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unlimited_timezone_changes_challenge_participant_idx"
  ON "unlimited_challenge_timezone_changes" USING btree ("challenge_id", "participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unlimited_timezone_changes_user_confirmed_idx"
  ON "unlimited_challenge_timezone_changes" USING btree ("user_id", "confirmed_at");
