import { pgTable, text, timestamp, boolean, jsonb, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

export const pushNotificationStatusEnum = pgEnum("push_notification_status", [
  "sent",
  "skipped_disabled",
  "skipped_no_device",
  "failed",
]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "race_invite",
  "friend_request",
  "friend_request_accepted",
  "race_starting",
  "race_started",
  "race_completed",
  "race_won",
  "race_lost",
  "reward_pending",
  "reward_approved",
  "reward_rejected",
  "withdrawal_requested",
  "withdrawal_approved",
  "withdrawal_rejected",
  "followed_player_started_race",
  "country_battle_update",
  "friend_daily_goal_completed",
]);

// ── In-app notifications ───────────────────────────────────────────────────────
export const notificationsTable = pgTable(
  "notifications",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_created_idx").on(t.createdAt),
    index("notifications_unread_idx").on(t.userId, t.isRead),
  ],
);

// ── Push notification devices (OneSignal) ─────────────────────────────────────
export const notificationDevicesTable = pgTable(
  "notification_devices",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    onesignalPlayerId: text("onesignal_player_id").notNull(),
    platform: text("platform").notNull().default("unknown"),
    deviceModel: text("device_model"),
    appVersion: text("app_version"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_devices_user_idx").on(t.userId),
    uniqueIndex("notification_devices_player_unique_idx").on(t.onesignalPlayerId),
  ],
);

// ── User notification preferences ─────────────────────────────────────────────
export const userNotificationPreferencesTable = pgTable(
  "user_notification_preferences",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().unique(),
    pushNotificationsEnabled: boolean("push_notifications_enabled").notNull().default(true),
    raceUpdatesEnabled: boolean("race_updates_enabled").notNull().default(true),
    inviteUpdatesEnabled: boolean("invite_updates_enabled").notNull().default(true),
    rewardUpdatesEnabled: boolean("reward_updates_enabled").notNull().default(true),
    chatUpdatesEnabled: boolean("chat_updates_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_notif_prefs_user_idx").on(t.userId),
  ],
);

// ── Push notification send log ─────────────────────────────────────────────────
export const pushNotificationLogsTable = pgTable(
  "push_notification_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    onesignalResponse: jsonb("onesignal_response").$type<Record<string, unknown>>(),
    status: pushNotificationStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("push_notif_logs_user_idx").on(t.userId),
    index("push_notif_logs_created_idx").on(t.createdAt),
  ],
);
