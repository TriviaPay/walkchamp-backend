-- Pre-existing drift: this table was applied out-of-band by
-- scripts/src/apply-step-device-totals-table.ts, so it already exists on deployed databases.
-- Created idempotently here to bring migration history back in sync.
CREATE TABLE IF NOT EXISTS "step_daily_device_totals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"device_id" text NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"distance_meters" integer DEFAULT 0 NOT NULL,
	"calories_burned" integer DEFAULT 0 NOT NULL,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"source_class" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "step_daily_device_totals_user_date_device_idx" ON "step_daily_device_totals" USING btree ("user_id","date","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_daily_device_totals_user_date_idx" ON "step_daily_device_totals" USING btree ("user_id","date");--> statement-breakpoint

-- ── Short (6-char) invitation codes ──────────────────────────────────────────
-- Invitation codes shrink from "WC" + 12 chars to 6 chars. A code is issued once and never
-- rotated afterwards, so this one-time rewrite is the only time an existing code changes.

-- 1. Canonicalise referred_by BEFORE rewriting codes. Signup stores whatever the invitee typed,
--    which may be the referrer's (about to change) code; /referral/apply already stores the
--    referrer's id. Rewriting to ids first keeps every pending referral bonus resolvable.
UPDATE "profiles" AS p
SET "referred_by" = r."id"
FROM "profiles" AS r
WHERE p."referred_by" IS NOT NULL
  AND btrim(p."referred_by") <> ''
  AND r."referral_code" IS NOT NULL
  AND upper(btrim(p."referred_by")) = upper(r."referral_code")
  AND p."referred_by" <> r."id";--> statement-breakpoint

-- 2. Issue a unique 6-char code to every profile that does not already have one. Entropy comes
--    from gen_random_uuid(): bytes 0-5 of a v4 uuid are fully random (the version/variant bits
--    live in bytes 6 and 8), and 256 % 32 = 0 so the byte→alphabet mapping carries no modulo
--    bias — same alphabet and reasoning as src/lib/inviteCodes.ts.
DO $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  target record;
  candidate text;
  source_bytes bytea;
  attempts int;
  i int;
BEGIN
  FOR target IN
    SELECT "id" FROM "profiles" WHERE "referral_code" IS NULL OR length("referral_code") <> 6
  LOOP
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      source_bytes := uuid_send(gen_random_uuid());
      candidate := '';
      FOR i IN 0..5 LOOP
        candidate := candidate || substr(alphabet, (get_byte(source_bytes, i) % 32) + 1, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "profiles" WHERE "referral_code" = candidate);
      IF attempts > 20 THEN
        RAISE EXCEPTION 'could not allocate a unique 6-char referral code for profile %', target."id";
      END IF;
    END LOOP;
    UPDATE "profiles" SET "referral_code" = candidate, "updated_at" = now() WHERE "id" = target."id";
  END LOOP;
END $$;--> statement-breakpoint

-- 3. Enforce uniqueness from here on — the short code space is small enough that the application
--    allocator (src/lib/uniqueCodes.ts) needs an index to retry against.
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_referral_code_unique" UNIQUE("referral_code");
