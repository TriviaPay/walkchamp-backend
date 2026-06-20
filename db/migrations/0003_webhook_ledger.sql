ALTER TABLE "payment_events"
  ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS "provider_event_id" text,
  ADD COLUMN IF NOT EXISTS "payload_reference" text,
  ADD COLUMN IF NOT EXISTS "processing_status" text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "processing_attempt_count" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_reason" text,
  ADD COLUMN IF NOT EXISTS "received_at" timestamp DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "processed_at" timestamp;
--> statement-breakpoint
UPDATE "payment_events"
SET
  "provider" = COALESCE("provider", 'stripe'),
  "provider_event_id" = COALESCE("provider_event_id", "stripe_event_id"),
  "processing_status" = CASE
    WHEN "processed" = true THEN 'processed'
    ELSE COALESCE("processing_status", 'pending')
  END,
  "processing_attempt_count" = COALESCE("processing_attempt_count", 0),
  "received_at" = COALESCE("received_at", "created_at")
WHERE
  "provider" IS NULL
  OR "provider_event_id" IS NULL
  OR "processing_status" IS NULL
  OR "processing_attempt_count" IS NULL
  OR "received_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "payment_events"
  ALTER COLUMN "provider" SET NOT NULL,
  ALTER COLUMN "provider_event_id" SET NOT NULL,
  ALTER COLUMN "processing_status" SET NOT NULL,
  ALTER COLUMN "processing_attempt_count" SET NOT NULL,
  ALTER COLUMN "received_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_events" DROP CONSTRAINT IF EXISTS "payment_events_stripe_event_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_provider_event_unique_idx"
ON "payment_events" USING btree ("provider", "provider_event_id");
--> statement-breakpoint
ALTER TABLE "deposit_webhook_events"
  ADD COLUMN IF NOT EXISTS "processing_status" text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "processing_attempt_count" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_reason" text,
  ADD COLUMN IF NOT EXISTS "payload_reference" text;
--> statement-breakpoint
UPDATE "deposit_webhook_events"
SET
  "processing_status" = CASE
    WHEN "processed" = true THEN 'processed'
    ELSE COALESCE("processing_status", 'pending')
  END,
  "processing_attempt_count" = COALESCE("processing_attempt_count", 0)
WHERE
  "processing_status" IS NULL
  OR "processing_attempt_count" IS NULL;
--> statement-breakpoint
ALTER TABLE "deposit_webhook_events"
  ALTER COLUMN "processing_status" SET NOT NULL,
  ALTER COLUMN "processing_attempt_count" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deposit_webhook_events" DROP CONSTRAINT IF EXISTS "deposit_webhook_events_provider_event_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_webhook_events_provider_event_unique_idx"
ON "deposit_webhook_events" USING btree ("provider", "provider_event_id");
