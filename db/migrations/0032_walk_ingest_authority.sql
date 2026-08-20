CREATE TABLE IF NOT EXISTS "walk_ingest_control" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "mode" text DEFAULT 'postgres' NOT NULL,
  "epoch" bigint DEFAULT 1 NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reason" text,
  CONSTRAINT "walk_ingest_control_singleton" CHECK ("id" = 1),
  CONSTRAINT "walk_ingest_control_mode" CHECK ("mode" IN ('postgres', 'redis_shadow', 'redis', 'rehydrating'))
);--> statement-breakpoint
INSERT INTO "walk_ingest_control" ("id", "mode", "epoch", "reason")
VALUES (1, 'postgres', 1, 'initial migration')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "step_daily_totals" ADD COLUMN IF NOT EXISTS "ingest_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_daily_totals" ADD COLUMN IF NOT EXISTS "ingest_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_daily_device_totals" ADD COLUMN IF NOT EXISTS "ingest_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_daily_device_totals" ADD COLUMN IF NOT EXISTS "ingest_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_sessions" ADD COLUMN IF NOT EXISTS "ingest_session_key" text;--> statement-breakpoint
ALTER TABLE "step_sessions" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_sessions" ADD COLUMN IF NOT EXISTS "session_final" boolean DEFAULT false NOT NULL;
