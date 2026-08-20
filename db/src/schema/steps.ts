import { pgTable, text, integer, bigint, timestamp, date, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

export const walkIngestControlTable = pgTable("walk_ingest_control", {
  id: integer("id").primaryKey().default(1),
  mode: text("mode").notNull().default("postgres"),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(1),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  reason: text("reason"),
});

// ── Daily step totals per user (one row per user per day) ─────────────────────
export const stepDailyTotalsTable = pgTable(
  "step_daily_totals",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    date: date("date").notNull(),
    steps: integer("steps").notNull().default(0),
    distanceMeters: integer("distance_meters").notNull().default(0),
    caloriesBurned: integer("calories_burned").notNull().default(0),
    activeMinutes: integer("active_minutes").notNull().default(0),
    goal: integer("goal").notNull().default(10000),
    // Verified-daily separation: "verified" (all sessions from Health Connect/HealthKit),
    // "unverified" (all provisional sensor sources), or "mixed". Provisional Walk-screen
    // estimates never mark a day as verified.
    sourceClass: text("source_class").notNull().default("unverified"),
    ingestEpoch: bigint("ingest_epoch", { mode: "number" }).notNull().default(0),
    ingestVersion: bigint("ingest_version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("step_daily_totals_user_date_idx").on(t.userId, t.date),
    index("step_daily_totals_user_idx").on(t.userId),
  ],
);

// ── Per-device daily step contribution (same account, multiple physical devices) ──
// Health Connect/HealthKit totals are device-wide, not account-wide. Each device's
// absolute daily reading is tracked separately (GREATEST per device, same anti-double-
// count guarantee as before) and step_daily_totals.steps is the SUM across devices —
// so a user who genuinely walks with two phones on the same day gets credit for both,
// while a single device restarting/resyncing never double-counts itself.
export const stepDailyDeviceTotalsTable = pgTable(
  "step_daily_device_totals",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    date: date("date").notNull(),
    deviceId: text("device_id").notNull(),
    steps: integer("steps").notNull().default(0),
    distanceMeters: integer("distance_meters").notNull().default(0),
    caloriesBurned: integer("calories_burned").notNull().default(0),
    activeMinutes: integer("active_minutes").notNull().default(0),
    sourceClass: text("source_class").notNull().default("unverified"),
    ingestEpoch: bigint("ingest_epoch", { mode: "number" }).notNull().default(0),
    ingestVersion: bigint("ingest_version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("step_daily_device_totals_user_date_device_idx").on(
      t.userId,
      t.date,
      t.deviceId,
    ),
    index("step_daily_device_totals_user_date_idx").on(t.userId, t.date),
  ],
);

// ── Individual walk sessions (start → stop) ───────────────────────────────────
export const stepSessionsTable = pgTable(
  "step_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    steps: integer("steps").notNull().default(0),
    distanceMeters: integer("distance_meters").notNull().default(0),
    caloriesBurned: integer("calories_burned").notNull().default(0),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    isSynced: boolean("is_synced").notNull().default(false),
    /** Step data source: ios_healthkit | android_health_connect | android_step_counter */
    source: text("source"),
    // True only when `source` normalizes to a verified health source (health_connect | healthkit).
    isVerifiedSource: boolean("is_verified_source").notNull().default(false),
    ingestSessionKey: text("ingest_session_key"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    sessionFinal: boolean("session_final").notNull().default(false),
  },
  (t) => [
    index("step_sessions_user_idx").on(t.userId),
    index("step_sessions_started_idx").on(t.startedAt),
    uniqueIndex("step_sessions_ingest_session_key_idx").on(t.ingestSessionKey),
  ],
);

// ── User Step Sources (wearable / health-app connection tracking) ─────────────
export const userStepSourcesTable = pgTable(
  "user_step_sources",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    platform: text("platform").notNull(), // ios_healthkit | android_health_connect | manual_unknown
    sourceName: text("source_name"),
    permissionStatus: text("permission_status").notNull().default("not_requested"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    setupCompleted: boolean("setup_completed").notNull().default(false),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_step_sources_user_platform_idx").on(t.userId, t.platform)],
);
