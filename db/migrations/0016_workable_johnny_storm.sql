-- Schema cleanup: remove redundant/dead columns and consolidate the duplicated
-- challenge_id reference onto race_room_id.
--
-- NOTE: drizzle-kit also emitted a CREATE TABLE "referral_bonus_awards" here due
-- to pre-existing snapshot drift (that table was created by migration 0014). It
-- already exists, so those statements were removed; the 0016 snapshot now records
-- the table, resolving the drift for future generates.

-- ── Backfill before dropping challenge_id ─────────────────────────────────────
-- challenge_id always held the race room id. Preserve any rows where it was set
-- but race_room_id was not, so no historical linkage is lost.
UPDATE "wallet_transactions"
  SET "race_room_id" = "challenge_id"
  WHERE "race_room_id" IS NULL AND "challenge_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "payments"
  SET "race_room_id" = "challenge_id"
  WHERE "race_room_id" IS NULL AND "challenge_id" IS NOT NULL;
--> statement-breakpoint

-- ── Drop redundant / dead columns ─────────────────────────────────────────────
-- profiles.age            — derived from date_of_birth, never read (computed at read time)
-- profiles.wallet_balance — dead; cash balance lives in wallets.available_balance_cents
-- *.challenge_id          — duplicated race_room_id (backfilled above)
ALTER TABLE "profiles" DROP COLUMN "age";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "wallet_balance";--> statement-breakpoint
ALTER TABLE "wallet_transactions" DROP COLUMN "challenge_id";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "challenge_id";
