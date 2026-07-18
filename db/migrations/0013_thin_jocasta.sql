-- Single active session support.
--
-- NOTE: This project's newer schema (refunds, outbox_events, sponsored_gift_card_awards,
-- live_activity_tokens, etc.) is applied via `drizzle-kit push`; the committed migration
-- chain stopped being authoritative after 0012. `drizzle-kit generate` therefore emitted a
-- large diff recreating those existing tables. This migration has been trimmed to contain
-- ONLY the auth-session change and is written idempotently so it is safe to apply against a
-- DB that was built via push. The accompanying 0013 snapshot was kept because it is the most
-- complete snapshot of the real schema and makes future `generate` runs clean.

CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action,
	"session_id" text NOT NULL,
	"session_generation" integer DEFAULT 1 NOT NULL,
	"descope_session_id" text,
	"device_id" text,
	"platform" text,
	"app_version" text,
	"build_number" text,
	"status" text DEFAULT 'active' NOT NULL,
	"invalidation_reason" text,
	"replaced_by_session_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_session_id_unique_idx" ON "auth_sessions" USING btree ("session_id");--> statement-breakpoint
-- The database guarantee: at most one active session per user.
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_user_active_unique_idx" ON "auth_sessions" USING btree ("user_id") WHERE "auth_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_user_status_idx" ON "auth_sessions" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "notification_devices" ADD COLUMN IF NOT EXISTS "device_id" text;--> statement-breakpoint
ALTER TABLE "notification_devices" ADD COLUMN IF NOT EXISTS "session_id" text;
