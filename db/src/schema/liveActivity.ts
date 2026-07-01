import { pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { profilesTable } from "./profiles.js";
import { raceRoomsTable } from "./races.js";

export const liveActivityTokensTable = pgTable(
  "live_activity_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    raceId: uuid("race_id")
      .notNull()
      .references(() => raceRoomsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => profilesTable.id, { onDelete: "cascade" }),
    activityId: text("activity_id").notNull(),
    platform: text("platform").notNull().default("ios"),
    pushToken: text("push_token").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("live_activity_tokens_race_idx").on(t.raceId),
    index("live_activity_tokens_user_idx").on(t.userId),
    uniqueIndex("live_activity_tokens_race_user_active_idx").on(t.raceId, t.userId),
  ],
);
