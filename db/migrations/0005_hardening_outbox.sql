CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "topic" text NOT NULL,
  "event_type" text NOT NULL,
  "aggregate_type" text,
  "aggregate_id" text,
  "idempotency_key" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_at" timestamp NOT NULL DEFAULT now(),
  "locked_at" timestamp,
  "locked_by" text,
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "dispatched_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_idempotency_key_unique_idx"
  ON "outbox_events" USING btree ("idempotency_key");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx"
  ON "outbox_events" USING btree ("status", "available_at");

CREATE TABLE IF NOT EXISTS "notification_delivery" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "template" text NOT NULL,
  "entity_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "payload" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "delivered_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_delivery_user_template_entity_unique_idx"
  ON "notification_delivery" USING btree ("user_id", "template", "entity_id");

CREATE TABLE IF NOT EXISTS "race_finalization_locks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "lock_owner" text NOT NULL,
  "final_state_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "released_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "race_finalization_locks_race_unique_idx"
  ON "race_finalization_locks" USING btree ("race_id");

CREATE TABLE IF NOT EXISTS "finalization_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "final_state_version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "finalization_attempts_race_version_unique_idx"
  ON "finalization_attempts" USING btree ("race_id", "final_state_version");
