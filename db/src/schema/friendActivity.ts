import { pgTable, text, integer, timestamp, date, jsonb, index } from "drizzle-orm/pg-core";

export const friendActivityEventsTable = pgTable(
  "friend_activity_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    eventDate: date("event_date").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    stepCount: integer("step_count").default(0),
    goalSteps: integer("goal_steps").default(0),
    notifiedCount: integer("notified_count").default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("friend_activity_user_date_idx").on(t.userId, t.eventDate),
    index("friend_activity_event_type_idx").on(t.eventType),
  ],
);
