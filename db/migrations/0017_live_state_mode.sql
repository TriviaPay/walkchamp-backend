ALTER TABLE "race_rooms" ADD COLUMN "live_state_mode" text DEFAULT 'postgres' NOT NULL;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "live_state_version" integer DEFAULT 0 NOT NULL;