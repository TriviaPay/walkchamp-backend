ALTER TYPE "public"."race_status" ADD VALUE IF NOT EXISTS 'voided';--> statement-breakpoint

ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "protected_race" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "protection_policy_version" text;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "protected_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "protected_policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "server_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "adjudication_status" text;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "adjudication_reason_codes" jsonb;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "adjudication_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN IF NOT EXISTS "void_reason" text;--> statement-breakpoint
ALTER TABLE "race_participants" ADD COLUMN IF NOT EXISTS "protected_tie_group" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "race_verification_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "participant_id" uuid NOT NULL REFERENCES "race_participants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE RESTRICT,
  "auth_session_id" text NOT NULL,
  "registered_device_id" text NOT NULL,
  "platform" text NOT NULL,
  "approved_health_platform" text NOT NULL,
  "approved_source" text NOT NULL,
  "server_start_at" timestamp with time zone,
  "server_end_at" timestamp with time zone,
  "app_version" text,
  "build_number" text,
  "integrity_status" text DEFAULT 'pending' NOT NULL,
  "continuity_status" text DEFAULT 'HEALTHY' NOT NULL,
  "review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_contact_at" timestamp with time zone DEFAULT now() NOT NULL,
  "offline_since" timestamp with time zone,
  "cumulative_offline_seconds" integer DEFAULT 0 NOT NULL,
  "max_continuous_offline_seconds" integer DEFAULT 0 NOT NULL,
  "permission_status" text DEFAULT 'unknown' NOT NULL,
  "source_stable" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_verification_sessions_race_user_uniq" ON "race_verification_sessions" ("race_id", "user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_verification_sessions_race_participant_uniq" ON "race_verification_sessions" ("race_id", "participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_verification_sessions_status_idx" ON "race_verification_sessions" ("race_id", "integrity_status", "continuity_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_verification_sessions_device_idx" ON "race_verification_sessions" ("registered_device_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integrity_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "verification_session_id" uuid NOT NULL REFERENCES "race_verification_sessions"("id") ON DELETE CASCADE,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE RESTRICT,
  "registered_device_id" text NOT NULL,
  "purpose" text NOT NULL,
  "challenge_hash" text NOT NULL,
  "expected_request_hash" text,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrity_challenges_hash_uniq" ON "integrity_challenges" ("challenge_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrity_challenges_session_lookup_idx" ON "integrity_challenges" ("verification_session_id", "purpose", "expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrity_challenges_unconsumed_idx" ON "integrity_challenges" ("expires_at") WHERE "consumed_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "race_result_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "participant_id" uuid NOT NULL REFERENCES "race_participants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "profiles"("id") ON DELETE RESTRICT,
  "verification_session_id" uuid NOT NULL REFERENCES "race_verification_sessions"("id") ON DELETE RESTRICT,
  "challenge_id" uuid NOT NULL REFERENCES "integrity_challenges"("id") ON DELETE RESTRICT,
  "platform" text NOT NULL,
  "app_version" text,
  "registered_device_id" text NOT NULL,
  "server_start_at" timestamp with time zone NOT NULL,
  "server_end_at" timestamp with time zone NOT NULL,
  "approved_source" text NOT NULL,
  "qualifying_steps" integer NOT NULL,
  "provisional_steps" integer NOT NULL,
  "verification_read_at" timestamp with time zone NOT NULL,
  "source_verdict" text NOT NULL,
  "integrity_verdict" text NOT NULL,
  "continuity_verdict" text NOT NULL,
  "reconciliation_verdict" text NOT NULL,
  "fraud_risk_verdict" text NOT NULL,
  "offline_verdict" text NOT NULL,
  "evidence_hash" text NOT NULL,
  "canonical_request_hash" text NOT NULL,
  "integrity_provider" text NOT NULL,
  "integrity_reference" text,
  "risk_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_evidence_summary" jsonb,
  "winning_margin" integer,
  "close_result_threshold" integer,
  "close_result_flag" boolean DEFAULT false NOT NULL,
  "close_result_group" text,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_result_evidence_session_hash_uniq" ON "race_result_evidence" ("verification_session_id", "evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_result_evidence_race_participant_uniq" ON "race_result_evidence" ("race_id", "participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "race_result_evidence_challenge_uniq" ON "race_result_evidence" ("challenge_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_result_evidence_race_idx" ON "race_result_evidence" ("race_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_result_evidence_participant_idx" ON "race_result_evidence" ("participant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "race_adjudication_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_id" uuid NOT NULL REFERENCES "race_rooms"("id") ON DELETE CASCADE,
  "participant_id" uuid REFERENCES "race_participants"("id") ON DELETE SET NULL,
  "verification_session_id" uuid REFERENCES "race_verification_sessions"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "old_decision" text,
  "new_decision" text NOT NULL,
  "reason_code" text NOT NULL,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_user_id" text,
  "evidence_reference" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_adjudication_events_race_idx" ON "race_adjudication_events" ("race_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "race_adjudication_events_participant_idx" ON "race_adjudication_events" ("participant_id", "created_at");
