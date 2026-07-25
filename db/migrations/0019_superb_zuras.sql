ALTER TYPE "public"."race_status" ADD VALUE 'starting';--> statement-breakpoint
ALTER TYPE "public"."race_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'race_cancelled' BEFORE 'race_won';--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "room_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "minimum_participants" integer;