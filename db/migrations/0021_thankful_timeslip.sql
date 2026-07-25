CREATE TABLE "unlimited_challenge_days" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day_number" integer NOT NULL,
	"local_date" date NOT NULL,
	"timezone" text NOT NULL,
	"window_start_utc" timestamp with time zone NOT NULL,
	"window_end_utc" timestamp with time zone NOT NULL,
	"goal_steps" integer NOT NULL,
	"verified_steps" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"passed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unlimited_challenge_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"participant_timezone" text NOT NULL,
	"timezone_locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"qualification_status" text DEFAULT 'active' NOT NULL,
	"disqualified_at" timestamp with time zone,
	"disqualification_reason" text,
	"entry_contribution_cents" integer NOT NULL,
	"platform_fee_cents" integer DEFAULT 50 NOT NULL,
	"payment_reference" text,
	"payout_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unlimited_challenge_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"payout_cents" integer NOT NULL,
	"wallet_tx_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unlimited_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"host_user_id" text NOT NULL,
	"title" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"invite_code" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"entry_fee_cents" integer NOT NULL,
	"platform_fee_cents" integer DEFAULT 50 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"daily_goal_steps" integer DEFAULT 10000 NOT NULL,
	"duration_days" integer NOT NULL,
	"start_at_utc" timestamp with time zone NOT NULL,
	"registration_closes_at_utc" timestamp with time zone NOT NULL,
	"challenge_end_at_utc" timestamp with time zone NOT NULL,
	"settlement_not_before_utc" timestamp with time zone NOT NULL,
	"started_at_utc" timestamp with time zone,
	"prize_pool_cents" integer DEFAULT 0 NOT NULL,
	"paid_participant_count" integer DEFAULT 0 NOT NULL,
	"qualified_participant_count" integer,
	"zero_winner_policy" text DEFAULT 'manual_review' NOT NULL,
	"settlement_status" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unlimited_challenges_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "unlimited_days_participant_day_uniq" ON "unlimited_challenge_days" USING btree ("challenge_id","participant_id","day_number");--> statement-breakpoint
CREATE INDEX "unlimited_days_challenge_local_date_idx" ON "unlimited_challenge_days" USING btree ("challenge_id","local_date");--> statement-breakpoint
CREATE INDEX "unlimited_days_finalize_idx" ON "unlimited_challenge_days" USING btree ("status","window_end_utc");--> statement-breakpoint
CREATE UNIQUE INDEX "unlimited_participants_challenge_user_uniq" ON "unlimited_challenge_participants" USING btree ("challenge_id","user_id");--> statement-breakpoint
CREATE INDEX "unlimited_participants_user_idx" ON "unlimited_challenge_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "unlimited_participants_challenge_status_idx" ON "unlimited_challenge_participants" USING btree ("challenge_id","qualification_status");--> statement-breakpoint
CREATE UNIQUE INDEX "unlimited_payouts_challenge_participant_uniq" ON "unlimited_challenge_payouts" USING btree ("challenge_id","participant_id");--> statement-breakpoint
CREATE INDEX "unlimited_payouts_challenge_idx" ON "unlimited_challenge_payouts" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "unlimited_challenges_status_idx" ON "unlimited_challenges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "unlimited_challenges_start_idx" ON "unlimited_challenges" USING btree ("start_at_utc");--> statement-breakpoint
CREATE INDEX "unlimited_challenges_end_idx" ON "unlimited_challenges" USING btree ("challenge_end_at_utc");--> statement-breakpoint
CREATE INDEX "unlimited_challenges_visibility_status_idx" ON "unlimited_challenges" USING btree ("visibility","status");