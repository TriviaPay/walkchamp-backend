ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'group_daily_goal_completed';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_daily_goal_notification_events" (
  "id" text PRIMARY KEY NOT NULL,
  "completed_user_id" text NOT NULL,
  "group_id" text NOT NULL,
  "local_date" date NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "recipient_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "data_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "provider_response" jsonb,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_goal_notif_completed_group_date_unique_idx"
  ON "group_daily_goal_notification_events" USING btree ("completed_user_id", "group_id", "local_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_goal_notif_completed_user_idx"
  ON "group_daily_goal_notification_events" USING btree ("completed_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_goal_notif_group_date_idx"
  ON "group_daily_goal_notification_events" USING btree ("group_id", "local_date");
