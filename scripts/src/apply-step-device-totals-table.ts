/**
 * apply-step-device-totals-table.ts
 * Creates the step_daily_device_totals table (per-device daily step contribution,
 * same account/multiple physical devices). Idempotent — safe to re-run.
 *
 * Run: pnpm run apply-step-device-totals-table
 */

import { db } from "@db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Creating step_daily_device_totals table (if missing)...");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS step_daily_device_totals (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      date date NOT NULL,
      device_id text NOT NULL,
      steps integer NOT NULL DEFAULT 0,
      distance_meters integer NOT NULL DEFAULT 0,
      calories_burned integer NOT NULL DEFAULT 0,
      active_minutes integer NOT NULL DEFAULT 0,
      source_class text NOT NULL DEFAULT 'unverified',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS step_daily_device_totals_user_date_device_idx
      ON step_daily_device_totals(user_id, date, device_id);
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS step_daily_device_totals_user_date_idx
      ON step_daily_device_totals(user_id, date);
  `);
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
