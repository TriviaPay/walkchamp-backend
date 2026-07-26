CREATE TYPE "public"."live_step_source" AS ENUM('healthkit', 'health_connect', 'android_step_counter', 'ios_pedometer', 'simulation', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('pending', 'matched', 'within_tolerance', 'verification_delayed', 'review_required', 'finalized');--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "live_source" "live_step_source";--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "live_session_id" text;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "verified_cumulative_steps" integer;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "verification_source" text;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "verified_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "verified_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "reconciled_steps" integer;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "reconciliation_status" "reconciliation_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN "reconciliation_reason_codes" jsonb;--> statement-breakpoint
ALTER TABLE "step_daily_totals" ADD COLUMN "source_class" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "step_sessions" ADD COLUMN "is_verified_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "race_results" ADD COLUMN "reconciliation_status" text;--> statement-breakpoint
ALTER TABLE "race_results" ADD COLUMN "authoritative_step_source" text;