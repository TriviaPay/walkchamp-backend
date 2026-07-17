CREATE TYPE "public"."sponsored_gift_card_award_status" AS ENUM('pending_fulfillment', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsored_gift_card_awards" (
  "id" text PRIMARY KEY NOT NULL,
  "race_room_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "prize_amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "provider" text DEFAULT 'amazon' NOT NULL,
  "status" "sponsored_gift_card_award_status" DEFAULT 'pending_fulfillment' NOT NULL,
  "recipient_email" text,
  "fulfillment_reference" text,
  "fulfillment_code" text,
  "fulfillment_notes" text,
  "fulfilled_by" text,
  "fulfilled_at" timestamp with time zone,
  "cancelled_by" text,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "sponsored_gift_card_awards"
  ADD CONSTRAINT "sponsored_gift_card_awards_race_room_id_race_rooms_id_fk"
  FOREIGN KEY ("race_room_id") REFERENCES "public"."race_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsored_gift_card_awards"
  ADD CONSTRAINT "sponsored_gift_card_awards_user_id_profiles_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sponsored_gift_card_awards_room_user_uniq"
  ON "sponsored_gift_card_awards" USING btree ("race_room_id", "user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_gift_card_awards_status_idx"
  ON "sponsored_gift_card_awards" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsored_gift_card_awards_user_idx"
  ON "sponsored_gift_card_awards" USING btree ("user_id");
