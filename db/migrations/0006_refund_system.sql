ALTER TABLE "wallet_transactions"
  ADD COLUMN IF NOT EXISTS "refund_id" uuid,
  ADD COLUMN IF NOT EXISTS "refund_item_id" uuid,
  ADD COLUMN IF NOT EXISTS "balance_before_cents" integer,
  ADD COLUMN IF NOT EXISTS "balance_after_cents" integer;

ALTER TABLE "coin_transactions"
  ADD COLUMN IF NOT EXISTS "refund_id" uuid,
  ADD COLUMN IF NOT EXISTS "refund_item_id" uuid;

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "request_source" text NOT NULL,
  "reason_code" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "idempotency_key" text NOT NULL,
  "requested_cash_cents" integer DEFAULT 0 NOT NULL,
  "approved_cash_cents" integer DEFAULT 0 NOT NULL,
  "succeeded_cash_cents" integer DEFAULT 0 NOT NULL,
  "requested_coin_amount" integer DEFAULT 0 NOT NULL,
  "succeeded_coin_amount" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text,
  "reviewed_by_user_id" text,
  "failure_code" text,
  "failure_message" text,
  "metadata" jsonb,
  "requested_at" timestamp DEFAULT now() NOT NULL,
  "approved_at" timestamp,
  "rejected_at" timestamp,
  "queued_at" timestamp,
  "processing_at" timestamp,
  "succeeded_at" timestamp,
  "failed_at" timestamp,
  "canceled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "refund_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "refund_id" uuid NOT NULL,
  "original_component_type" text NOT NULL,
  "original_component_id" text NOT NULL,
  "refund_action_key" text NOT NULL,
  "asset_type" text NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "destination" text NOT NULL,
  "provider" text,
  "provider_payment_id" text,
  "provider_charge_id" text,
  "provider_refund_id" text,
  "provider_refund_status" text,
  "provider_request_body" jsonb,
  "provider_idempotency_key" text,
  "wallet_transaction_id" uuid,
  "coin_transaction_id" text,
  "requested_amount" integer DEFAULT 0 NOT NULL,
  "approved_amount" integer DEFAULT 0 NOT NULL,
  "succeeded_amount" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "refund_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "refund_item_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_idempotency_key" text NOT NULL,
  "request_body" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "response_body" jsonb,
  "http_status" integer,
  "attempt_status" text DEFAULT 'started' NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "refund_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_type" text NOT NULL,
  "race_room_id" uuid,
  "status" text DEFAULT 'requested' NOT NULL,
  "total_items" integer DEFAULT 0 NOT NULL,
  "succeeded_items" integer DEFAULT 0 NOT NULL,
  "failed_items" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "provider_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_refund_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "processed" integer DEFAULT 0 NOT NULL,
  "processing_status" text DEFAULT 'pending' NOT NULL,
  "processing_error" text,
  "unresolved" integer DEFAULT 0 NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp
);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_user_id_profiles_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_created_by_user_id_profiles_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_reviewed_by_user_id_profiles_id_fk"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "refund_items"
  ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk"
  FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "refund_attempts"
  ADD CONSTRAINT "refund_attempts_refund_item_id_refund_items_id_fk"
  FOREIGN KEY ("refund_item_id") REFERENCES "public"."refund_items"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "refunds_idempotency_key_unique_idx"
  ON "refunds" USING btree ("idempotency_key");
CREATE INDEX IF NOT EXISTS "refunds_user_created_idx"
  ON "refunds" USING btree ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "refunds_status_created_idx"
  ON "refunds" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "refunds_source_idx"
  ON "refunds" USING btree ("source_type", "source_id");

CREATE UNIQUE INDEX IF NOT EXISTS "refund_items_component_action_unique_idx"
  ON "refund_items" USING btree ("original_component_type", "original_component_id", "refund_action_key");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_items_provider_refund_unique_idx"
  ON "refund_items" USING btree ("provider", "provider_refund_id");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_items_provider_idempotency_unique_idx"
  ON "refund_items" USING btree ("provider_idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_items_wallet_tx_unique_idx"
  ON "refund_items" USING btree ("wallet_transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_items_coin_tx_unique_idx"
  ON "refund_items" USING btree ("coin_transaction_id");
CREATE INDEX IF NOT EXISTS "refund_items_refund_idx"
  ON "refund_items" USING btree ("refund_id");
CREATE INDEX IF NOT EXISTS "refund_items_status_idx"
  ON "refund_items" USING btree ("status");

CREATE INDEX IF NOT EXISTS "refund_attempts_item_created_idx"
  ON "refund_attempts" USING btree ("refund_item_id", "created_at");

CREATE INDEX IF NOT EXISTS "refund_batches_race_idx"
  ON "refund_batches" USING btree ("race_room_id");
CREATE INDEX IF NOT EXISTS "refund_batches_status_idx"
  ON "refund_batches" USING btree ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "provider_webhook_events_provider_event_unique_idx"
  ON "provider_webhook_events" USING btree ("provider", "provider_event_id");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_refund_idx"
  ON "provider_webhook_events" USING btree ("provider", "provider_refund_id");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_unresolved_idx"
  ON "provider_webhook_events" USING btree ("unresolved", "received_at");
