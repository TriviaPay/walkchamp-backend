CREATE TABLE IF NOT EXISTS "referral_bonus_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_user_id" text NOT NULL REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action,
	"referred_user_id" text NOT NULL REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action,
	"referral_code" text,
	"trigger_race_room_id" uuid NOT NULL,
	"referrer_transaction_id" uuid REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action,
	"referred_transaction_id" uuid REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action,
	"amount_cents" integer DEFAULT 300 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"metadata" jsonb,
	"credited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_bonus_awards_referred_user_unique_idx" ON "referral_bonus_awards" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_bonus_awards_referrer_idx" ON "referral_bonus_awards" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_bonus_awards_trigger_race_idx" ON "referral_bonus_awards" USING btree ("trigger_race_room_id");
