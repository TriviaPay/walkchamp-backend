ALTER TYPE "public"."wallet_transaction_type" ADD VALUE IF NOT EXISTS 'deposit_credit';
--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE IF NOT EXISTS 'deposit_refund_debit';
--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE IF NOT EXISTS 'chargeback_debit';
--> statement-breakpoint
ALTER TABLE "wallet_transactions"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "deposit_transaction_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "wallet_transactions"
    ADD CONSTRAINT "wallet_transactions_deposit_transaction_id_deposit_transactions_id_fk"
    FOREIGN KEY ("deposit_transaction_id") REFERENCES "public"."deposit_transactions"("id") ON DELETE SET NULL ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_idempotency_key_unique_idx"
ON "wallet_transactions" USING btree ("idempotency_key")
WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_deposit_credit_unique_idx"
ON "wallet_transactions" USING btree ("deposit_transaction_id")
WHERE "deposit_transaction_id" IS NOT NULL
  AND "transaction_type" = 'deposit_credit'::"public"."wallet_transaction_type";
--> statement-breakpoint
UPDATE "deposit_transactions"
SET "status" = 'processing', "updated_at" = now()
WHERE "status" = 'pending';
--> statement-breakpoint
ALTER TABLE "wallet_transactions" DROP CONSTRAINT IF EXISTS "wallet_transactions_signed_amount_check";
--> statement-breakpoint
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_signed_amount_check"
  CHECK (
    ("transaction_type"::text IN ('deposit_credit', 'race_prize_paid', 'withdrawal_rejected') AND "amount_cents" > 0)
    OR ("transaction_type"::text IN ('race_entry_wallet_debit', 'deposit_refund_debit', 'chargeback_debit', 'withdrawal_requested') AND "amount_cents" < 0)
    OR ("transaction_type"::text NOT IN ('deposit_credit', 'race_prize_paid', 'withdrawal_rejected', 'race_entry_wallet_debit', 'deposit_refund_debit', 'chargeback_debit', 'withdrawal_requested'))
  );
--> statement-breakpoint
ALTER TABLE "withdrawals"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_idempotency_key_unique_idx"
ON "withdrawals" USING btree ("idempotency_key")
WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operational_locks" (
  "key" text PRIMARY KEY NOT NULL,
  "locked" boolean DEFAULT false NOT NULL,
  "reason" text,
  "metadata" jsonb,
  "locked_at" timestamp,
  "resolved_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operational_locks_locked_idx"
ON "operational_locks" USING btree ("locked");
