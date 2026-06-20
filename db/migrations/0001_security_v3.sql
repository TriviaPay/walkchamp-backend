CREATE TABLE IF NOT EXISTS "ad_reward_claims" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "claim_id" text NOT NULL,
  "reward_date" date NOT NULL,
  "network" text,
  "placement" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
  "key" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "description" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" text,
  "actor_type" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "reason" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled", "description")
VALUES
  ('cash_features', false, 'Enable all cash wallet, payment, and withdrawal flows'),
  ('coin_entry_challenges', false, 'Enable coin-entry race modes'),
  ('legacy_presence_online_ids', false, 'Enable legacy broad presence endpoint')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD COLUMN IF NOT EXISTS "reason_code" text;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD COLUMN IF NOT EXISTS "balance_after" integer;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
UPDATE "coin_transactions"
SET "reason_code" = COALESCE("reason_code", 'legacy')
WHERE "reason_code" IS NULL;
--> statement-breakpoint
UPDATE "coin_transactions"
SET "idempotency_key" = COALESCE("idempotency_key", 'legacy:' || "id")
WHERE "idempotency_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ALTER COLUMN "reason_code" SET DEFAULT 'unspecified';
--> statement-breakpoint
ALTER TABLE "coin_transactions" ALTER COLUMN "reason_code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "coin_transactions" ALTER COLUMN "idempotency_key" SET NOT NULL;
--> statement-breakpoint
WITH duplicate_transactions AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "transaction_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "user_purchases"
  WHERE "transaction_id" IS NOT NULL
)
UPDATE "user_purchases" up
SET "transaction_id" = NULL
FROM duplicate_transactions dup
WHERE up."id" = dup."id"
  AND dup.rn > 1;
--> statement-breakpoint
WITH duplicate_purchase_tokens AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "purchase_token"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "user_purchases"
  WHERE "purchase_token" IS NOT NULL
)
UPDATE "user_purchases" up
SET "purchase_token" = NULL
FROM duplicate_purchase_tokens dup
WHERE up."id" = dup."id"
  AND dup.rn > 1;
--> statement-breakpoint
WITH duplicate_reports AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "message_id", "reported_by_user_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "chat_message_reports"
)
DELETE FROM "chat_message_reports" c
USING duplicate_reports dup
WHERE c."id" = dup."id"
  AND dup.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_reward_claims_claim_idx" ON "ad_reward_claims" USING btree ("claim_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_reward_claims_user_date_idx" ON "ad_reward_claims" USING btree ("user_id","reward_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" USING btree ("action");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "msg_reports_message_reporter_idx" ON "chat_message_reports" USING btree ("message_id","reported_by_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coin_transactions_user_idempotency_idx" ON "coin_transactions" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coin_transactions_source_idx" ON "coin_transactions" USING btree ("source","source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_purchases_transaction_unique" ON "user_purchases" USING btree ("transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_purchases_purchase_token_unique" ON "user_purchases" USING btree ("purchase_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_purchases_user_created_idx" ON "user_purchases" USING btree ("user_id","created_at");
