import { pgTable, text, timestamp, boolean, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

export const friendStatusEnum = pgEnum("friend_status", ["pending", "accepted", "rejected", "blocked"]);
export const friendRequestDirectionEnum = pgEnum("friend_request_direction", ["sent", "received"]);

// ── Friends table ─────────────────────────────────────────────────────────────
export const friendsTable = pgTable(
  "friends",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    friendId: text("friend_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("friends_pair_idx").on(t.userId, t.friendId),
    index("friends_user_idx").on(t.userId),
  ],
);

// ── Friend requests ───────────────────────────────────────────────────────────
export const friendRequestsTable = pgTable(
  "friend_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    senderId: text("sender_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    status: friendStatusEnum("status").notNull().default("pending"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("friend_requests_pair_idx").on(t.senderId, t.recipientId),
    index("friend_requests_recipient_idx").on(t.recipientId),
  ],
);

// ── Blocked users ─────────────────────────────────────────────────────────────
export const blockedUsersTable = pgTable(
  "blocked_users",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    blockerId: text("blocker_id").notNull(),
    blockedId: text("blocked_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("blocked_users_pair_idx").on(t.blockerId, t.blockedId),
    index("blocked_users_blocker_idx").on(t.blockerId),
  ],
);
