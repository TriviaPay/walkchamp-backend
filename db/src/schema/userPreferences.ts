import { pgTable, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const userPreferencesTable = pgTable(
  "user_preferences",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    dailyStepGoal: integer("daily_step_goal").notNull().default(10000),
    distanceUnit: text("distance_unit").notNull().default("km"),
    timezone: text("timezone").notNull().default("UTC"),
    notifyFriendsOnDailyGoal: boolean("notify_friends_on_daily_goal").notNull().default(true),
    receiveFriendActivityNotifications: boolean("receive_friend_activity_notifications").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_preferences_user_id_idx").on(t.userId),
  ],
);
