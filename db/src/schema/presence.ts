import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

export const presenceStatusEnum = pgEnum("presence_status", [
  "online", "walking", "racing", "spectating", "away", "offline",
]);

// ── User presence (heartbeat-driven, one row per user) ────────────────────────
export const userPresenceTable = pgTable(
  "user_presence",
  {
    userId: text("user_id").primaryKey(),
    status: presenceStatusEnum("status").notNull().default("online"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastWalkActivityAt: timestamp("last_walk_activity_at", { withTimezone: true }),
    deviceId: text("device_id"),
  },
  (t) => [
    index("user_presence_status_idx").on(t.status),
    index("user_presence_last_seen_idx").on(t.lastSeenAt),
    index("user_presence_last_walk_idx").on(t.lastWalkActivityAt),
  ],
);
