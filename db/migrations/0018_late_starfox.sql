ALTER TABLE "race_participants" ADD COLUMN "forfeited_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "starting_participant_count" integer;--> statement-breakpoint
ALTER TABLE "race_rooms" ADD COLUMN "winner_slot_count" integer;--> statement-breakpoint
ALTER TABLE "race_results" ADD COLUMN "winner_position" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "race_results_room_winner_position_uniq" ON "race_results" USING btree ("race_room_id","winner_position") WHERE "race_results"."winner_position" IS NOT NULL;