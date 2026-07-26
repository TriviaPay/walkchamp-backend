CREATE TABLE "verification_decision_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"live_steps" integer,
	"verified_steps" integer,
	"reconciled_steps" integer,
	"verification_status" text,
	"decision" text NOT NULL,
	"reason_code" text,
	"decided_by" text DEFAULT 'system' NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "settlement_status" text;--> statement-breakpoint
CREATE INDEX "verification_decision_audit_race_idx" ON "verification_decision_audit" USING btree ("race_id");--> statement-breakpoint
CREATE INDEX "verification_decision_audit_user_idx" ON "verification_decision_audit" USING btree ("user_id");